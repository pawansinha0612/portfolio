<?xml version="1.0" encoding="UTF-8"?>
<!-- Shows blog/feed.xml as a readable page when it's opened in a browser. Feed readers ignore this file. -->
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:output method="html" encoding="UTF-8" indent="yes"/>
  <xsl:template match="/rss/channel">
    <html lang="en">
      <head>
        <meta charset="utf-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <meta name="robots" content="noindex"/>
        <title>RSS feed — <xsl:value-of select="title"/></title>
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&amp;display=swap"/>
        <link rel="stylesheet" href="/styles.css"/>
        <style>
          .feed { max-width: 760px; padding: 56px 16px 80px; }
          .feed h1 { font-size: clamp(30px, 5vw, 42px); margin: 0 0 12px; line-height: 1.15; }
          .feed-how { margin: 28px 0 36px; padding: 18px 20px; border: 1px solid var(--border); border-radius: 14px; background: var(--surface); }
          .feed-how p { margin: 0 0 10px; color: var(--muted); }
          .feed-how code { display: block; padding: 10px 12px; border-radius: 8px; background: var(--alt); font-size: 14px; word-break: break-all; }
          .feed-item { padding: 20px 0; border-top: 1px solid var(--border); }
          .feed-item h2 { margin: 0 0 6px; font-size: 20px; }
          .feed-item h2 a { text-decoration: none; color: var(--text); }
          .feed-item h2 a:hover { color: var(--accent); }
          .feed-item p { margin: 0; color: var(--muted); }
          .feed-item small { color: var(--muted); }
        </style>
      </head>
      <body>
        <main class="wrap feed">
          <p class="eyebrow">RSS feed</p>
          <h1><xsl:value-of select="title"/></h1>
          <p class="lead"><xsl:value-of select="description"/></p>
          <div class="feed-how">
            <p><strong>This is a feed for news readers.</strong> To get every new post automatically, copy this address into a feed reader such as Feedly, Inoreader or NetNewsWire:</p>
            <code>https://pawansinha.com.au/blog/feed.xml</code>
            <p style="margin:12px 0 0">Prefer email? <a href="/blog/">Subscribe on the blog</a>. Or just <a href="/blog/">read the blog</a>.</p>
          </div>
          <xsl:choose>
            <xsl:when test="item">
              <xsl:for-each select="item">
                <article class="feed-item">
                  <h2><a href="{link}"><xsl:value-of select="title"/></a></h2>
                  <p><xsl:value-of select="description"/></p>
                  <small><xsl:value-of select="substring(pubDate, 6, 11)"/></small>
                </article>
              </xsl:for-each>
            </xsl:when>
            <xsl:otherwise>
              <p class="feed-item">The first post is on its way. Add the feed now and it will appear in your reader as soon as it's published.</p>
            </xsl:otherwise>
          </xsl:choose>
        </main>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
