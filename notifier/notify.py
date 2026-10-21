#!/usr/bin/env python3
"""Availability notifier: tell your network you're free before a contract ends.

Commands:
  status                 Days left on the contract and who has been emailed.
  preview [--to EMAIL]   Print the email exactly as one contact would get it.
  send [--dry-run] [--tag TAG] [--yes]
                         Email every contact not yet emailed for this contract.
  check                  For a daily scheduled job: inside the notice window it shows a
                         macOS reminder, or sends automatically if "auto_send" is true.

Each contract (identified by contract_end_date) is a separate campaign, so nobody gets
the same email twice, and setting a new end date starts fresh.
"""
import argparse
import csv
import json
import os
import smtplib
import ssl
import subprocess
import sys
import time
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = HERE / "config.json"
CONTACTS = HERE / "contacts.csv"
TEMPLATE = HERE / "template.txt"
SENT_LOG = HERE / "sent_log.json"
ENV_FILE = HERE / ".env"


def load_env():
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_config():
    if not CONFIG.exists():
        sys.exit(f"Missing {CONFIG.name}. Copy config.example.json to config.json and edit it.")
    cfg = json.loads(CONFIG.read_text())
    cfg["_end"] = date.fromisoformat(cfg["contract_end_date"])
    cfg["_available"] = date.fromisoformat(cfg.get("available_from") or
                                           (cfg["_end"] + timedelta(days=1)).isoformat())
    return cfg


def load_contacts(tag=None):
    if not CONTACTS.exists():
        sys.exit(f"Missing {CONTACTS.name}. Copy contacts.example.csv to contacts.csv and add people.")
    with CONTACTS.open(newline="", encoding="utf-8-sig") as f:
        rows = [r for r in csv.DictReader(f) if (r.get("email") or "").strip()]
    rows = [r for r in rows if (r.get("opt_out") or "").strip().lower() not in ("y", "yes", "true", "1")]
    if tag:
        rows = [r for r in rows if tag.lower() in [t.strip().lower() for t in (r.get("tags") or "").split(";")]]
    return rows


def load_sent(cfg):
    log = json.loads(SENT_LOG.read_text()) if SENT_LOG.exists() else {}
    return log, log.setdefault(cfg["contract_end_date"], {})


def save_sent(log):
    SENT_LOG.write_text(json.dumps(log, indent=2))


def render(cfg, contact):
    first = (contact.get("first_name") or contact.get("name") or "there").strip().split(" ")[0]
    note = (contact.get("personal_note") or "").strip()
    values = {
        "first_name": first,
        "personal_note": (note + "\n\n") if note else "",
        "available_from": cfg["_available"].strftime("%-d %B %Y"),
        "my_name": cfg["my_name"],
        "headline": cfg["headline"],
        "skills": cfg["skills"],
        "website": cfg["website"],
        "upwork": cfg["upwork"],
        "linkedin": cfg["linkedin"],
        "phone": cfg.get("phone", ""),
    }
    text = TEMPLATE.read_text().format(**values)
    subject_line, _, body = text.partition("\n")
    return subject_line.removeprefix("Subject:").strip(), body.lstrip("\n")


def build_message(cfg, contact, sender):
    subject, body = render(cfg, contact)
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((cfg["my_name"], sender))
    msg["To"] = formataddr(((contact.get("name") or "").strip(), contact["email"].strip()))
    msg["Message-ID"] = make_msgid()
    msg.set_content(body)
    return msg


def days_left(cfg):
    return (cfg["_end"] - date.today()).days


def cmd_status(cfg, _args):
    contacts = load_contacts()
    _, sent = load_sent(cfg)
    left = days_left(cfg)
    window = cfg.get("notify_days_before", 30)
    print(f"Contract ends:   {cfg['_end']:%a %d %b %Y}  ({left} days left)")
    print(f"Available from:  {cfg['_available']:%a %d %b %Y}")
    print(f"Notice window:   {window} days before end -> "
          f"{'OPEN, time to send' if left <= window else f'opens in {left - window} days'}")
    print(f"Contacts:        {len(contacts)} active, {len(sent)} already emailed for this contract")
    pending = [c["email"] for c in contacts if c["email"].strip().lower() not in sent]
    if pending:
        print(f"Not yet emailed: {', '.join(pending[:10])}{' ...' if len(pending) > 10 else ''}")


def cmd_preview(cfg, args):
    contacts = load_contacts()
    if args.to:
        contacts = [c for c in contacts if c["email"].strip().lower() == args.to.lower()]
        if not contacts:
            sys.exit(f"No contact with email {args.to}")
    msg = build_message(cfg, contacts[0], os.environ.get("SMTP_USER", "you@example.com"))
    print(f"To: {msg['To']}\nSubject: {msg['Subject']}\n\n{msg.get_content()}")


def send_all(cfg, tag=None, dry_run=False):
    contacts = load_contacts(tag)
    log, sent = load_sent(cfg)
    pending = [c for c in contacts if c["email"].strip().lower() not in sent]
    if not pending:
        print("Everyone has already been emailed for this contract.")
        return 0

    if dry_run:
        for c in pending:
            print(f"[dry run] would email {c.get('name', '')} <{c['email']}>")
        print(f"{len(pending)} email(s) would be sent.")
        return 0

    host = os.environ.get("SMTP_HOST", "smtp.gmail.com")
    port = int(os.environ.get("SMTP_PORT", "465"))
    user = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASSWORD")
    if not user or not password:
        sys.exit("Set SMTP_USER and SMTP_PASSWORD in notifier/.env (see .env.example).")

    delay = cfg.get("seconds_between_emails", 5)
    count = 0
    with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context()) as smtp:
        smtp.login(user, password)
        for c in pending:
            email = c["email"].strip()
            try:
                smtp.send_message(build_message(cfg, c, user))
            except smtplib.SMTPException as e:
                print(f"FAILED {email}: {e}")
                continue
            sent[email.lower()] = datetime.now().isoformat(timespec="seconds")
            save_sent(log)  # save after each one so a crash never causes a duplicate
            count += 1
            print(f"Sent  {email}")
            time.sleep(delay)
    print(f"Done: {count}/{len(pending)} sent.")
    return count


def cmd_send(cfg, args):
    if not args.dry_run and not args.yes:
        n = len([c for c in load_contacts(args.tag) if c["email"].strip().lower() not in load_sent(cfg)[1]])
        if input(f"Send availability email to {n} contact(s)? [y/N] ").strip().lower() != "y":
            print("Cancelled.")
            return
    send_all(cfg, args.tag, args.dry_run)


def mac_notify(title, message):
    if sys.platform == "darwin":
        subprocess.run(["osascript", "-e", f'display notification "{message}" with title "{title}"'],
                       check=False)
    print(f"{title}: {message}")


def cmd_check(cfg, _args):
    left = days_left(cfg)
    window = cfg.get("notify_days_before", 30)
    if left > window:
        print(f"{left} days left; notice window opens in {left - window} days. Nothing to do.")
        return
    _, sent = load_sent(cfg)
    pending = [c for c in load_contacts() if c["email"].strip().lower() not in sent]
    if not pending:
        print("Inside notice window and everyone has been emailed.")
        return
    if cfg.get("auto_send"):
        send_all(cfg)
        mac_notify("Availability emails sent", f"Contract ends in {left} days.")
    else:
        mac_notify("Contract ending soon",
                   f"{left} days left. {len(pending)} contacts to tell: run notify.py send")


def main():
    load_env()
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    pv = sub.add_parser("preview")
    pv.add_argument("--to", help="preview for this contact's email")
    sd = sub.add_parser("send")
    sd.add_argument("--dry-run", action="store_true", help="list who would be emailed, send nothing")
    sd.add_argument("--tag", help="only contacts with this tag (e.g. recruiter)")
    sd.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    sub.add_parser("check")
    args = p.parse_args()
    cfg = load_config()
    {"status": cmd_status, "preview": cmd_preview, "send": cmd_send, "check": cmd_check}[args.cmd](cfg, args)


if __name__ == "__main__":
    main()
