/* CI/CD Failure Detective: pure functions, no DOM. Runs in the browser (window.CIDetective) and in Node
   (module.exports) for toolkit-tests/ci-failure-detective.test.js. Nothing is sent anywhere.

   clean(text)                 strip ANSI colour codes, carriage-return progress bars and timestamp prefixes
   detectCI(text)              'github' | 'gitlab' | 'jenkins' | 'azure' | 'circleci' | 'unknown'
   analyse(text)               matched failure signatures with line numbers and context, the first real error
                               (root cause candidate) versus follow-on noise, failed tests, exit code, summary
   parseTests(lines)           failed and passed tests from Jest, pytest, JUnit/Maven/Gradle, Playwright, Go, .NET, RSpec, Cypress
   parseJUnitXML(xml)          JUnit XML → test cases (hand-written parser: no DOMParser, so it also runs in Node)
   multiRun(runs)              several logs or JUnit files → per-test history, flaky tests, recurring failures, category trend
   toMarkdown(result), multiToMarkdown(multi)
*/
(function (root) {
  'use strict';

  const CATS = {
    infra: 'Infrastructure / network', deps: 'Dependency / install', build: 'Compile / build', test: 'Test failure', flaky: 'Flaky / timing',
    resource: 'Resource (memory / disk)', auth: 'Auth / permissions / secrets', docker: 'Docker / registry', deploy: 'Deployment / Kubernetes',
    timeout: 'Timeout / cancelled', config: 'Config / YAML', quality: 'Quality gate / lint', exit: 'Exit status (follow-on)',
  };

  // Each signature: id, cat, title, re (tested per line), cause, fix. generic: true means it is usually a consequence
  // of an earlier error (exit codes, "BUILD FAILED"), so it is never picked as the root cause when anything else matched.
  // rank: higher = more likely to be the real root cause when several match.
  const S = (id, cat, title, re, cause, fix, extra) => Object.assign({ id, cat, title, re, cause, fix, rank: 5 }, extra || {});
  const SIGNATURES = [
    // ---------------------------------------------------------------- infra / network
    S('econnreset', 'infra', 'Connection reset (ECONNRESET)', /\bECONNRESET\b|socket hang up|Connection reset by peer/i,
      'The other end closed the network connection mid-request. Usually a flaky registry, proxy or rate limiter rather than your code.',
      'Retry the job. If it keeps happening, add retries to the install step (npm config set fetch-retries 5), use a registry mirror or cache dependencies.', { rank: 6 }),
    S('etimedout', 'infra', 'Network timeout (ETIMEDOUT)', /\bETIMEDOUT\b|\bESOCKETTIMEDOUT\b|connect timed out|Connection timed out|Read timed out|i\/o timeout/i,
      'A network call took too long. The target (registry, API, database) is slow, blocked by a firewall, or unreachable from the runner.',
      'Check the host is reachable from the runner (proxy, firewall, VPN, private network). Raise the client timeout and retry; cache dependencies to avoid the download.', { rank: 6 }),
    S('dns', 'infra', 'Host name could not be resolved', /\bENOTFOUND\b|getaddrinfo\s+EAI_AGAIN|Could not resolve host|Temporary failure in name resolution|Name or service not known|no such host|UnknownHostException/i,
      'DNS lookup failed: the host name is wrong, internal-only, or DNS on the runner had a blip.',
      'Check the URL for typos. Internal hosts need a self-hosted runner inside the network. Retry once for transient DNS errors.', { rank: 7 }),
    S('econnrefused', 'infra', 'Connection refused', /\bECONNREFUSED\b|Connection refused|actively refused/i,
      'Nothing is listening on that host and port. Often a service container (database, API) that has not started yet, or the wrong port.',
      'Wait for the service to be healthy before tests start (health check, wait-on, docker compose --wait). Check host name: inside a job, a service is reached by its service name, not localhost.', { rank: 7 }),
    S('tls', 'infra', 'TLS / certificate error', /SSL certificate problem|unable to get local issuer certificate|self[- ]signed certificate|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|PKIX path building failed|certificate verify failed|x509: certificate/i,
      'The runner does not trust the server certificate: a corporate proxy that re-signs traffic, a self-signed internal certificate, or an expired one.',
      'Add the corporate root certificate to the runner (NODE_EXTRA_CA_CERTS, REQUESTS_CA_BUNDLE, Java truststore). Do not turn verification off in a pipeline.', { rank: 7 }),
    S('ratelimit', 'infra', 'Rate limited (HTTP 429)', /\b429\b.*(Too Many Requests|rate)|Too Many Requests|API rate limit exceeded|rate limit(ed)? exceeded|secondary rate limit/i,
      'A service (GitHub API, package registry, Docker Hub) is throttling the runner because of too many requests from the same IP or token.',
      'Authenticate requests (GITHUB_TOKEN, registry login) for higher limits, cache downloads, and add back-off retries. Spread scheduled jobs out.', { rank: 7 }),
    S('http5xx', 'infra', 'Upstream server error (502/503/504)', /\b(502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out)\b/i,
      'A server the job depends on was down or overloaded.', 'Retry the job; check the status page of the registry or service. Add retries with back-off to the step.'),
    S('runnerlost', 'infra', 'Runner or agent lost', /runner has received a shutdown signal|lost communication with the server|Agent went offline|ChannelClosedException|Cannot contact .*: java\.io|The hosted runner encountered an error|runner system failure/i,
      'The machine running the job went away: preempted spot instance, crashed agent, or the runner ran out of memory.',
      'Re-run. If it repeats, check the agent host for memory and disk, and avoid spot instances for long jobs.', { rank: 8 }),
    S('eaddrinuse', 'infra', 'Port already in use', /\bEADDRINUSE\b|address already in use|Port \d+ is already in use|BindException/i,
      'Two processes tried to listen on the same port: a server from an earlier step still running, or parallel jobs on one machine.',
      'Stop servers at the end of each step, use a random free port, or isolate parallel jobs in containers.', { rank: 7 }),

    // ---------------------------------------------------------------- dependency / install
    S('eresolve', 'deps', 'npm could not resolve peer dependencies (ERESOLVE)', /npm ERR! code ERESOLVE|ERESOLVE unable to resolve dependency tree|ERESOLVE could not resolve/i,
      'Two packages ask for incompatible versions of a peer dependency. npm 7+ treats this as an error.',
      'Upgrade the package that pins the old peer version. As a stop-gap, npm ci --legacy-peer-deps (or add legacy-peer-deps=true to .npmrc) and commit the lock file.', { rank: 9 }),
    S('npmci-lock', 'deps', 'package-lock.json out of sync', /npm ci` can only install packages when your package\.json and package-lock\.json|Missing: .+ from lock file|lockfile.*out of (sync|date)|Invalid: lock file's/i,
      'package.json was changed without updating package-lock.json, so npm ci refuses to install.',
      'Run npm install locally, commit the updated package-lock.json, and make sure the same npm major version is used locally and in CI.', { rank: 9 }),
    S('frozen-lock', 'deps', 'Lock file needs updating (frozen lockfile)', /Your lockfile needs to be updated, but yarn was run with `--frozen-lockfile`|ERR_PNPM_OUTDATED_LOCKFILE|ERR_PNPM_LOCKFILE|The lockfile would have been modified by this install, which is explicitly forbidden/i,
      'The lock file does not match package.json, and CI installs in frozen mode.',
      'Run yarn install / pnpm install locally and commit the lock file.', { rank: 9 }),
    S('npm404', 'deps', 'Package not found in registry (E404)', /npm ERR! code E404|npm ERR! 404|404 Not Found - GET https?:\/\/registry|ERR_PNPM_FETCH_404|error An unexpected error occurred: ".*: Request failed \\"404/i,
      'The package or version does not exist in the registry the runner uses, or it is a private package and the runner is not logged in.',
      'Check the name and version. For private packages, add the registry and token to .npmrc in CI (NODE_AUTH_TOKEN).', { rank: 9 }),
    S('npmauth', 'auth', 'Registry authentication failed (E401/E403)', /npm ERR! code E40[13]|ERR_PNPM_FETCH_40[13]|Unable to authenticate, need: Basic|npm ERR! 40[13]/i,
      'The registry rejected the runner: missing, expired or wrong token for a private registry.',
      'Set NODE_AUTH_TOKEN (or the registry token secret) for the job and check it has read access. Tokens often expire after 30–90 days.', { rank: 9 }),
    S('nodegyp', 'deps', 'Native module build failed (node-gyp)', /gyp ERR!|node-gyp rebuild|prebuild-install WARN install No prebuilt binaries/i,
      'A package with native code had no prebuilt binary for this Node version or OS, and compiling it failed.',
      'Use a Node version the package supports (check .nvmrc), install build tools (python3, make, g++) on the runner, or upgrade the package.', { rank: 8 }),
    S('engine', 'deps', 'Wrong Node / runtime version', /The engine "node" is incompatible|EBADENGINE|Unsupported engine|requires Node(?:\.js)? (?:version )?[>=^~]|SyntaxError: Unexpected token '\?\.'|Unsupported class file major version|has been compiled by a more recent version of the Java Runtime|invalid target release|requires-python/i,
      'The runner uses a different language version than the project needs.',
      'Pin the version in the pipeline (actions/setup-node with node-version-file: .nvmrc, setup-java, image tag) so CI and laptops match.', { rank: 9 }),
    S('pip-nomatch', 'deps', 'pip could not find the package version', /No matching distribution found for|Could not find a version that satisfies the requirement/i,
      'The version does not exist, does not support this Python version or platform, or the private index is not reachable.',
      'Check the version on PyPI against the Python version in the job. For private indexes set PIP_INDEX_URL / PIP_EXTRA_INDEX_URL with credentials.', { rank: 9 }),
    S('pip-conflict', 'deps', 'pip dependency conflict', /ResolutionImpossible|pip's dependency resolver does not currently take into account|Cannot install .* because these package versions have conflicting dependencies/i,
      'Two requirements need incompatible versions of the same package.', 'Loosen or align the pins, then lock with pip-tools, Poetry or uv so CI installs exactly what you tested.', { rank: 8 }),
    S('maven-deps', 'deps', 'Maven could not resolve dependencies', /Could not resolve dependencies for project|Failed to collect dependencies|Could not transfer artifact|Could not find artifact|Non-resolvable parent POM|was cached in the local repository, resolution will not be reattempted/i,
      'An artifact is missing from the repositories Maven can reach, the repository needs credentials, or the network to it failed.',
      'Check the artifact coordinates and the settings.xml servers/mirrors in CI. Run with -U to force a re-check after a failed download.', { rank: 9 }),
    S('gradle-deps', 'deps', 'Gradle could not resolve dependencies', /Could not resolve all (files|dependencies|artifacts) for configuration|Could not resolve [\w.-]+:[\w.-]+:|Could not GET 'https?:/i,
      'Gradle could not download a dependency: wrong version, missing repository, missing credentials or network failure.',
      'Check repositories {} and credentials in CI, then run with --refresh-dependencies. Cache ~/.gradle/caches between runs.', { rank: 9 }),
    S('go-mod', 'deps', 'Go module problem', /missing go\.sum entry|go: .* module .* not found|verifying .*: checksum mismatch|go: updates to go\.mod needed|cannot find module providing package/i,
      'go.mod or go.sum is out of date, or a module version does not exist.', 'Run go mod tidy locally and commit go.mod and go.sum. For private modules set GOPRIVATE and git credentials.', { rank: 9 }),
    S('mod-missing', 'deps', 'Module not found at runtime', /Error: Cannot find module|ModuleNotFoundError: No module named|ImportError: cannot import name|ERR_MODULE_NOT_FOUND|LoadError: cannot load such file/i,
      'Code imports a package that is not installed in the job, or a path that does not exist (case-sensitive file systems on Linux runners catch wrong capitalisation).',
      'Add the package to dependencies (not only devDependencies if production install is used), check the install step ran, and match file name case exactly.', { rank: 8 }),
    S('composer', 'deps', 'Composer / Bundler / NuGet restore failed', /Your requirements could not be resolved to an installable set of packages|Bundler could not find compatible versions|Could not find gem|error NU1101|error NU1102|Unable to find package/i,
      'The package manager could not find a set of versions that satisfies the project.', 'Update the lock file locally, commit it, and check private feed credentials in CI.', { rank: 8 }),

    // ---------------------------------------------------------------- compile / build
    S('tsc', 'build', 'TypeScript compile error', /error TS\d{3,5}:/,
      'TypeScript found a type error. CI often runs a stricter build than the dev server, which skips type checking.',
      'Run npx tsc --noEmit locally to see the same errors. Fix the first error first; later ones are often caused by it.', { rank: 9 }),
    S('javac', 'build', 'Java / Kotlin compilation error', /COMPILATION ERROR|cannot find symbol|error: incompatible types|\.java:\[\d+,\d+\] |e: .*\.kt:\s*\(\d+, \d+\)|Compilation failed; see the compiler error output/i,
      'The code does not compile: a missing import, a renamed method, or a generated class that was not regenerated.',
      'Build locally with the same command (mvn -B verify or ./gradlew build). Check generated sources and that the branch is up to date with main.', { rank: 9 }),
    S('cs', 'build', '.NET compile error', /error CS\d{4}:|error MSB\d{4}:|Build FAILED\.\s*$|error NETSDK\d+:/i,
      'The .NET build failed: a compile error or an MSBuild/SDK problem (often a missing or wrong SDK version).',
      'Pin the SDK with global.json and setup-dotnet. Fix the first CS error in the list.', { rank: 8 }),
    S('bundler', 'build', 'Bundler could not resolve an import', /Module not found: Error: Can't resolve|Could not resolve ".*" from|\[vite\]: Rollup failed to resolve import|Failed to resolve import/i,
      'An import path does not exist. On Linux runners, file names are case-sensitive, so Button.tsx and button.tsx are different files.',
      'Check the path and its capitalisation (git mv to fix case), and that the package is installed.', { rank: 9 }),
    S('syntax', 'build', 'Syntax error', /^\s*SyntaxError: |SyntaxError: Unexpected token|ParseError:|IndentationError:|unexpected EOF while parsing|Parse error: syntax error/i,
      'The code (or a config file loaded as code) could not be parsed.', 'Open the file and line in the error. A merge conflict marker (<<<<<<<) or an older runtime that does not support the syntax are common causes.', { rank: 8 }),
    S('go-build', 'build', 'Go build error', /\.go:\d+:\d+: (undefined|cannot use|declared and not used|imported and not used|syntax error)/,
      'The Go code does not compile.', 'Run go build ./... and go vet ./... locally; fix the first error.', { rank: 9 }),
    S('gradle-task', 'build', 'Gradle task failed', /Execution failed for task '([^']+)'/,
      'A Gradle task failed. The lines just above it say why.', 'Read the error above this line. Re-run locally with ./gradlew <task> --stacktrace.', { rank: 4 }),
    S('make', 'build', 'make target failed', /make(\[\d+\])?: \*\*\* \[.*\] Error \d+/,
      'A command run by make exited with an error. The real cause is in the output just above.', 'Scroll up to the first error printed by the failing command.', { generic: true, rank: 2 }),
    S('webpack', 'build', 'Build tool reported errors', /webpack compiled with \d+ errors?|Failed to compile\.|ERROR in |error during build:|Build failed with \d+ errors?/i,
      'The bundler failed. The specific error is listed next to this line.', 'Fix the first listed error and rebuild locally with the production build command.', { rank: 5 }),
    S('docker-build', 'docker', 'Docker build step failed', /failed to solve:|failed to compute cache key|COPY failed|executor failed running|ERROR \[.*\] RUN |did not complete successfully: exit code/i,
      'A step in the Dockerfile failed: a file missing from the build context (check .dockerignore), or a RUN command that errored.',
      'Look at the RUN output just above. For COPY errors, check the path is inside the build context and not excluded by .dockerignore.', { rank: 7 }),

    // ---------------------------------------------------------------- resource
    S('nospace', 'resource', 'Disk full (No space left on device)', /No space left on device|\bENOSPC\b|not enough space on the disk|disk quota exceeded|There is not enough space/i,
      'The runner ran out of disk: Docker images and layers, build caches and node_modules add up quickly.',
      'Free space before the build (docker system prune -af, remove unused SDKs on hosted runners), use smaller images, or a bigger runner.', { rank: 10 }),
    S('oomkilled', 'resource', 'Killed: out of memory (exit 137)', /\bOOMKilled\b|exit code 137|exited with code 137|status 137|signal: killed|^\s*Killed\s*$|Killed\s+(npm|node|java|python|gradle)|The runner has received a shutdown signal.*memory|out of memory: Killed process/i,
      'The operating system or container killed the process because it used more memory than allowed (exit 137 = SIGKILL).',
      'Lower memory use (fewer parallel workers: jest --maxWorkers=2, Gradle org.gradle.workers.max), raise the container memory limit, or use a bigger runner.', { rank: 10 }),
    S('java-oom', 'resource', 'Java OutOfMemoryError', /java\.lang\.OutOfMemoryError|OutOfMemoryError: (Java heap space|GC overhead limit exceeded|Metaspace)/,
      'The JVM ran out of heap (or Metaspace). In CI this is usually the build tool or test JVM with a default heap that is too small.',
      'Raise -Xmx for the right JVM: MAVEN_OPTS, org.gradle.jvmargs, or surefire argLine. If it grows with the test count, look for a leak in test setup.', { rank: 10 }),
    S('node-oom', 'resource', 'Node.js heap out of memory', /JavaScript heap out of memory|Reached heap limit Allocation failed|FATAL ERROR: .*Allocation failed/i,
      'Node hit its heap limit, often during a large TypeScript or webpack build.',
      'Set NODE_OPTIONS=--max-old-space-size=4096 for the step, and check the runner has that much memory.', { rank: 10 }),
    S('emfile', 'resource', 'Too many open files', /\bEMFILE\b|Too many open files/i,
      'The process hit the open file limit, often file watchers or many parallel connections.', 'Raise ulimit -n on self-hosted runners, turn off watch mode in CI (CI=true), and close connections in tests.', { rank: 8 }),
    S('segfault', 'resource', 'Crash (segmentation fault, exit 139)', /Segmentation fault|exit code 139|SIGSEGV/i,
      'A native process crashed. Often a native module built for a different OS or CPU, or a browser crashing because /dev/shm is too small in Docker.',
      'Rebuild native modules on the runner. For browsers in Docker, use --shm-size=1g or --disable-dev-shm-usage.', { rank: 8 }),

    // ---------------------------------------------------------------- auth / permissions / secrets
    S('publickey', 'auth', 'SSH key rejected (Permission denied (publickey))', /Permission denied \(publickey/i,
      'The SSH key in the job is missing or not authorised for the repository or server.',
      'Add the deploy key or SSH private key as a secret and load it (webfactory/ssh-agent or ssh-add). Or clone over HTTPS with a token.', { rank: 10 }),
    S('integration', 'auth', 'GitHub token lacks permission', /Resource not accessible by integration|Resource not accessible by personal access token/i,
      'GITHUB_TOKEN (or the PAT) does not have the permission this step needs, e.g. writing to pull requests, packages or contents. Forked pull requests always get a read-only token.',
      'Add a permissions: block to the workflow or job (e.g. contents: write, pull-requests: write). For forks, use pull_request_target carefully or skip the step.', { rank: 10 }),
    S('git-auth', 'auth', 'Git authentication failed', /remote: Permission to .* denied|Authentication failed for 'https?:|could not read Username for|fatal: unable to access '.*': The requested URL returned error: 40[13]|remote: Invalid username or password|HTTP Basic: Access denied/i,
      'The job could not authenticate to the Git server: missing token, expired token, or a token without access to that repository.',
      'Check the token secret, its expiry and its scopes. In GitHub Actions, actions/checkout needs a PAT to reach other private repositories.', { rank: 10 }),
    S('http401', 'auth', 'Unauthorised (401) or forbidden (403)', /\b401 Unauthorized\b|\b403 Forbidden\b|status code 40[13]\b|HTTP 40[13]\b/i,
      'A service rejected the job\'s credentials.', 'Check the secret is set for this branch or environment (protected secrets are hidden on unprotected branches) and has not expired.', { rank: 7 }),
    S('eacces', 'auth', 'File permission denied', /\bEACCES\b|Permission denied(?! \(publickey)|Operation not permitted|AccessDeniedException: \//i,
      'The job user cannot read, write or execute a file: a script without the executable bit, or files owned by root from a container step.',
      'git update-index --chmod=+x script.sh (and commit), run chmod in the job, or run the container as the runner user.', { rank: 7 }),
    S('missing-input', 'auth', 'Required secret or input is empty', /Input required and not supplied: |secret .* (not found|is empty|not set)|variable .* is (not set|empty|undefined)|Error: Missing required (env|environment) variable|KeyError: '[A-Z_]+'|undefined variable [A-Z_]+/i,
      'A secret or variable the step needs is empty. Secrets are not passed to workflows from forks, and protected variables only exist on protected branches.',
      'Check the secret name matches exactly, that it is defined for this environment or branch, and pass it to the step (with: / env:).', { rank: 9 }),
    S('cloud-auth', 'auth', 'Cloud credentials rejected', /ExpiredToken|InvalidClientTokenId|The security token included in the request is (invalid|expired)|is not authorized to perform:|AccessDenied(Exception)?|AADSTS\d+|could not find default credentials|Unable to locate credentials/i,
      'The cloud provider rejected the job\'s credentials or the role lacks a permission.',
      'Prefer OIDC (aws-actions/configure-aws-credentials with role-to-assume) over long-lived keys. Check the role\'s policy for the action named in the error.', { rank: 9 }),

    // ---------------------------------------------------------------- docker / registry
    S('toomanyrequests', 'docker', 'Docker Hub pull rate limit', /toomanyrequests|You have reached your (unauthenticated )?pull rate limit/i,
      'Docker Hub limits anonymous pulls per IP. Shared CI runners hit the limit quickly.',
      'Log in to Docker Hub before pulling (docker/login-action), or mirror images to your own registry (GHCR, ECR, Artifact Registry).', { rank: 10 }),
    S('manifest', 'docker', 'Image or tag not found (manifest unknown)', /manifest unknown|manifest for .* not found|not found: manifest unknown|no matching manifest for|failed to resolve reference .*: not found/i,
      'The image tag does not exist, was deleted, or is not built for the runner\'s CPU (amd64 versus arm64).',
      'Check the exact tag and that the build that pushes it ran first. Pin a tag that exists, and build multi-arch images if runners differ.', { rank: 10 }),
    S('pull-denied', 'docker', 'Registry access denied', /pull access denied|repository does not exist or may require 'docker login'|denied: requested access to the resource is denied|unauthorized: authentication required|no basic auth credentials|denied: permission_denied/i,
      'The registry needs a login, or the account cannot read or push that repository.',
      'Log in to the registry in the job before pull or push and check the repository name (including the namespace/organisation).', { rank: 10 }),
    S('docker-daemon', 'docker', 'Docker daemon not available', /Cannot connect to the Docker daemon|docker: command not found|error during connect: .*docker|Is the docker daemon running/i,
      'The job tried to use Docker where there is none: a container job without Docker-in-Docker, or a runner without Docker installed.',
      'Use a runner with Docker, add the docker:dind service (GitLab) or mount the socket on self-hosted agents.', { rank: 9 }),

    // ---------------------------------------------------------------- deployment / Kubernetes
    S('imagepull', 'deploy', 'Kubernetes cannot pull the image (ImagePullBackOff)', /ImagePullBackOff|ErrImagePull|Failed to pull image/i,
      'The cluster cannot pull the image: wrong tag, image not pushed yet, or no imagePullSecret for a private registry.',
      'kubectl describe pod shows the exact error. Check the tag that was deployed exists and the namespace has the pull secret.', { rank: 10 }),
    S('crashloop', 'deploy', 'Pod keeps crashing (CrashLoopBackOff)', /CrashLoopBackOff|Back-off restarting failed container/i,
      'The container starts then exits again and again: a startup error, missing config or secret, or failing liveness probe.',
      'kubectl logs <pod> --previous shows why the last start failed. Check env vars, secrets, config maps and probe timings.', { rank: 10 }),
    S('rollout', 'deploy', 'Rollout did not complete', /exceeded its progress deadline|error: timed out waiting for the condition|rollout status .* timed out|Readiness probe failed|deployment .* failed to become ready|context deadline exceeded/i,
      'New pods never became ready in time: failing readiness probes, crashing pods, or not enough cluster capacity.',
      'kubectl get pods and kubectl describe on a new pod show the reason. Check readiness probe paths and resource requests.', { rank: 8 }),
    S('k8s-conn', 'deploy', 'Cannot reach the Kubernetes API', /Unable to connect to the server|the server has asked for the client to provide credentials|You must be logged in to the server|error: You must be logged in|connection to the server .* was refused/i,
      'kubectl has no valid kubeconfig or credentials for the cluster, or the API is private and the runner is outside the network.',
      'Check the kubeconfig secret or cloud login step (aws eks update-kubeconfig, gcloud get-credentials) and whether the cluster API is reachable from the runner.', { rank: 9 }),
    S('rbac', 'deploy', 'Kubernetes RBAC forbidden', /Error from server \(Forbidden\)|forbidden: User .* cannot/i,
      'The deploy account is not allowed to do that in this namespace.', 'Grant the service account a Role/RoleBinding for that resource and verb, scoped to the namespace.', { rank: 9 }),
    S('helm', 'deploy', 'Helm release failed', /UPGRADE FAILED|INSTALLATION FAILED|another operation \(install\/upgrade\/rollback\) is in progress|has no deployed releases/i,
      'Helm could not install or upgrade. "Another operation is in progress" means a previous run was interrupted and left the release locked.',
      'helm history <release> shows the stuck revision; helm rollback to the last good one. Use --atomic so failed upgrades roll back automatically.', { rank: 9 }),
    S('terraform', 'deploy', 'Terraform failed', /Error acquiring the state lock|Error: Inconsistent dependency lock file|Error: Failed to query available provider packages|Error: (creating|updating|deleting) .+:/i,
      'Terraform could not finish. A state lock means another run is in progress or crashed while holding the lock.',
      'Wait for other runs, then terraform force-unlock <id> only if you are sure no run is active. For provider errors, run terraform init -upgrade and commit the lock file.', { rank: 8 }),

    // ---------------------------------------------------------------- tests
    S('jest', 'test', 'Jest tests failed', /^Tests:\s+[1-9]\d* failed|^\s*●\s+.+ › .+|Test Suites: [1-9]\d* failed/,
      'One or more Jest tests failed. The first ● block shows the assertion and the line.', 'Run the failing test file locally with the same CI=true environment. Check for order-dependent tests (jest --runInBand) and time zone differences.', { rank: 6 }),
    S('pytest', 'test', 'pytest tests failed', /^FAILED [\w/.\-]+\.py::|=+ .*\b[1-9]\d* failed.* in [\d.]+s|^E\s+(AssertionError|assert )/,
      'One or more pytest tests failed.', 'Run pytest <path>::<test> -x locally. The E lines show the failing assertion.', { rank: 6 }),
    S('surefire', 'test', 'JUnit tests failed (Maven Surefire)', /There are test failures|Tests run: \d+, Failures: [1-9]|Tests run: \d+, Failures: \d+, Errors: [1-9]|<<< FAILURE!|<<< ERROR!/,
      'One or more JUnit tests failed under Maven.', 'Open target/surefire-reports for the full stack trace, or run mvn -Dtest=ClassName#method test locally.', { rank: 6 }),
    S('gradle-test', 'test', 'JUnit tests failed (Gradle)', /There were failing tests|> Task :\w*test FAILED|\d+ tests completed, \d+ failed|\w+ > .+ FAILED$/i,
      'One or more tests failed under Gradle.', 'The HTML report is in build/reports/tests. Run ./gradlew test --tests "Class.method" locally.', { rank: 6 }),
    S('assertion', 'test', 'Assertion failed', /AssertionError|expect\(received\)|Expected: .+|Expected value|toBe\(|toEqual\(|assert\w*\(.*\) failed|ComparisonFailure|org\.opentest4j\.AssertionFailedError/,
      'A test assertion did not hold: the code returned something different from what the test expected.', 'Compare expected and actual in the message. If it only fails in CI, suspect time zone, locale, test order or shared data.', { rank: 6 }),
    S('go-test', 'test', 'Go test failed', /^--- FAIL: \S+|^FAIL\s+\S+\s+[\d.]+s$/,
      'A Go test failed: an assertion (t.Errorf / t.Fatalf) did not hold, or the test panicked.','Run go test -run TestName -v ./pkg locally; add -race to catch data races that only show in CI.', { rank: 6 }),
    S('pw-failed', 'test', 'Playwright tests failed', /^\s*\d+ failed\s*$|^\s+\d+\) \[[\w-]+\] › /,
      'One or more Playwright tests failed.', 'Download the HTML report or trace artefact (trace: on-first-retry) and open it with npx playwright show-trace.', { rank: 6 }),
    S('dotnet-test', 'test', '.NET tests failed', /Failed!\s+-\s+Failed:\s+[1-9]|^\s*Failed \S+ \[\d/,
      'One or more .NET tests (xUnit, NUnit or MSTest) failed.','Run dotnet test --filter FullyQualifiedName~TestName locally.', { rank: 6 }),
    S('cypress', 'test', 'Cypress tests failed', /\d+ of \d+ failed \(\d+%\)|CypressError:/,
      'One or more Cypress specs failed.', 'Check the screenshots and videos artefacts; run npx cypress run --spec <file> locally.', { rank: 6 }),

    // ---------------------------------------------------------------- flaky / timing
    S('pw-timeout', 'flaky', 'Playwright timeout exceeded', /Timeout \d+ms exceeded|Test timeout of \d+ms exceeded|waiting for (locator|selector|navigation)|page\.goto: Timeout/i,
      'A step waited too long for an element or page. In CI this is often a slower runner, an app that is not ready, or a selector that matches nothing.',
      'Wait on a web-first assertion (await expect(locator).toBeVisible()) instead of fixed waits, check the selector in the trace, and make sure the app is fully started before tests.', { rank: 7 }),
    S('not-interactable', 'flaky', 'Element not interactable', /element not interactable|ElementNotInteractableException|element is not visible|not clickable at point|Element is not attached to the DOM/i,
      'The element exists but cannot be used yet: hidden, covered, disabled or still animating.',
      'Wait for the element to be visible and enabled before clicking, close cookie banners and pop-ups first, and use a fixed viewport size in CI.', { rank: 7 }),
    S('stale', 'flaky', 'Stale element reference', /StaleElementReferenceException|stale element reference|element is not attached to the page document/i,
      'The page re-rendered after the test found the element, so the old reference is dead.', 'Look the element up again right before using it (Page Object methods instead of stored elements), or move to Playwright locators which re-resolve automatically.', { rank: 7 }),
    S('nosuchelement', 'flaky', 'Element not found', /NoSuchElementException|Unable to locate element|no such element|Timed out retrying after \d+ms|Expected to find element/i,
      'The selector matched nothing in time: the page was not ready, the selector changed, or a different page loaded (login, error page).',
      'Check the screenshot at failure. Prefer stable test ids (data-testid) and explicit waits for the page state.', { rank: 7 }),
    S('intercepted', 'flaky', 'Click intercepted by another element', /element click intercepted|Other element would receive the click|intercepts pointer events/i,
      'Something on top of the element (cookie banner, spinner, sticky header, toast) received the click.', 'Dismiss overlays first and wait for spinners to disappear.', { rank: 8 }),
    S('target-closed', 'flaky', 'Browser or page closed unexpectedly', /Target page, context or browser has been closed|Target closed|Browser closed|Session not created|chrome not reachable|DevToolsActivePort file doesn't exist/i,
      'The browser crashed or closed during the test: out of memory, /dev/shm too small in Docker, or the test ended before an action finished (missing await).',
      'Add --disable-dev-shm-usage or a bigger shm, check every Playwright call is awaited, and reduce parallel workers.', { rank: 8 }),
    S('flaky-marker', 'flaky', 'Tests passed only on retry', /^\s*\d+ flaky\s*$|passed on retry|flaky test|Rerun \d+:|retry #\d+/i,
      'Some tests failed first and passed when retried. The build is green, but the tests are not reliable.', 'Track these tests (multi-run mode below), fix the race or shared state, and quarantine any that keep flaking.', { rank: 3 }),

    // ---------------------------------------------------------------- timeout / cancelled
    S('gh-timeout', 'timeout', 'Job exceeded the maximum execution time', /has exceeded the maximum execution time|The job running on runner .* has exceeded/i,
      'The job ran past timeout-minutes (6 hours by default on GitHub-hosted runners). Something hung: a test waiting forever, an interactive prompt, or a server that never stopped.',
      'Set a sensible timeout-minutes, add timeouts to tests, and make every command non-interactive (CI=true, -y flags).', { rank: 8 }),
    S('cancelled', 'timeout', 'Job cancelled', /The operation was canceled|The operation was cancelled|Aborted by |Build was aborted|Canceling since a higher priority waiting request|job was canceled|Terminate batch job|received SIGTERM|exit code 143/i,
      'The job was stopped: by a user, a newer push (concurrency cancel-in-progress), or a timeout.', 'If nobody cancelled it, look for a timeout above. Concurrency groups cancel older runs on purpose.', { rank: 4 }),
    S('gitlab-timeout', 'timeout', 'GitLab job timed out', /execution took longer than|ERROR: Job failed: execution took longer than|There has been a timeout failure or the job got stuck|This job is stuck because/i,
      'The job ran past its timeout, or no runner with matching tags picked it up.', 'Raise the job timeout only after finding what hangs. For stuck jobs, check runner tags and that a runner is online.', { rank: 8 }),
    S('jenkins-timeout', 'timeout', 'Jenkins timeout', /Timeout has been exceeded|Cancelling nested steps due to timeout|Timeout set to expire/i,
      'A timeout() block in the Jenkinsfile expired.', 'Find the step running when the timeout hit; it usually waits on a network call, a lock or an input step.', { rank: 7 }),

    // ---------------------------------------------------------------- config / YAML
    S('gh-workflow', 'config', 'Invalid GitHub Actions workflow', /Invalid workflow file|The workflow is not valid|Unrecognized named-value|Unexpected value '|Required property is missing/i,
      'The workflow YAML is invalid, so GitHub cannot run it.', 'Open the Actions tab for the exact line. actionlint catches these before you push.', { rank: 10 }),
    S('gitlab-yaml', 'config', 'Invalid .gitlab-ci.yml', /yaml invalid|This GitLab CI configuration is invalid|jobs config should contain|jobs:.* config contains unknown keys|Included file .* does not have valid YAML/i,
      'The GitLab CI configuration is invalid.', 'Use CI/CD → Editor → Validate (or the CI Lint API) to find the line.', { rank: 10 }),
    S('yaml', 'config', 'YAML syntax error', /mapping values are not allowed|could not find expected ':'|did not find expected key|found character that cannot start any token|YAMLException|yaml: line \d+:/i,
      'A YAML file has a syntax error: usually indentation, a tab, or an unquoted colon.', 'Check the line named in the error. Quote values that contain ": " and use spaces, not tabs.', { rank: 9 }),
    S('jenkinsfile', 'config', 'Jenkinsfile error', /WorkflowScript: \d+: |No such DSL method|groovy\.lang\.MissingPropertyException|Scripts not permitted to use|org\.codehaus\.groovy\.control\.MultipleCompilationErrorsException/,
      'The Jenkinsfile is invalid, or calls a step from a plugin that is not installed, or is blocked by the script sandbox.',
      'Validate with the Pipeline linter (Replay or the declarative-linter CLI). Approve the method in Script Approval only if it is safe.', { rank: 10 }),
    S('cmd-not-found', 'config', 'Command not found (exit 127)', /command not found|is not recognized as an internal or external command|exit code 127|: not found$|executable file not found in \$PATH/i,
      'The job ran a tool that is not installed on the runner or image, or not on the PATH.', 'Install the tool in an earlier step or use an image that has it. Check the shell (sh vs bash) for bash-only syntax.', { rank: 9 }),
    S('action-missing', 'config', 'Action or template could not be found', /Unable to resolve action|Can't find 'action\.yml'|Could not find file .*action\.ya?ml|Unable to download action|Project .* not found or access denied/i,
      'A referenced action, template or include does not exist at that version, or the runner cannot access it.', 'Check the owner/name@ref spelling and that the tag or SHA exists. Private actions need access granted to the calling repository.', { rank: 9 }),

    // ---------------------------------------------------------------- quality gates / lint
    S('sonar', 'quality', 'SonarQube quality gate failed', /QUALITY GATE STATUS: (FAILED|ERROR)|Quality Gate (has )?failed|Quality gate failure|QualityGate status: ERROR/i,
      'The code met the build but failed SonarQube conditions: new coverage, duplications, bugs or security hotspots on new code.',
      'Open the Sonar dashboard link in the log to see which condition failed. Fix the new-code issues; avoid changing the gate to pass.', { rank: 8 }),
    S('eslint', 'quality', 'Lint errors', /✖ \d+ problems? \(\d+ errors?|\d+ errors? and \d+ warnings? potentially fixable|ESLint found too many warnings|Lint errors found|would reformat|Code style issues found|Found \d+ errors? in \d+ files?|You have \d+ Checkstyle violations|\[ERROR\] .*Checkstyle|ktlint|flake8.*E\d{3}/i,
      'The linter or formatter found problems, and the pipeline fails on them.', 'Run the same lint and format commands locally (npm run lint, prettier --check, black --check) and commit the fixes. A pre-commit hook stops this recurring.', { rank: 8 }),
    S('coverage', 'quality', 'Coverage threshold not met', /coverage threshold for .* not met|Coverage failure: total of|Required test coverage of .* not reached|Rule violated for bundle|coverage .* is below the minimum|FAIL Required test coverage/i,
      'Tests passed, but the code coverage is below the configured minimum.', 'Add tests for the new code, or check whether files were wrongly included in coverage (generated code, config).', { rank: 8 }),
    S('vulns', 'quality', 'Security scan found vulnerabilities', /found \d+ (high|critical) severity vulnerabilit|Total: \d+ \(.*CRITICAL: [1-9]|Tested \d+ dependencies for known issues, found [1-9]|vulnerabilities found|Vulnerabilities found|ERROR: Vulnerable dependencies found/i,
      'A dependency or image scanner found vulnerabilities above the allowed severity.', 'Upgrade the affected packages (npm audit fix, Dependabot or Renovate) or base image. Ignore a finding only with a written reason and expiry.', { rank: 8 }),

    // ---------------------------------------------------------------- generic exit status (follow-on noise)
    S('gh-exit', 'exit', 'Step exited with a non-zero code', /Process completed with exit code (\d+)/,
      'A step exited with an error code. This line is the result, not the cause.', 'Look for the first error above it.', { generic: true, rank: 1 }),
    S('gl-exit', 'exit', 'GitLab job failed', /ERROR: Job failed: (exit code|command terminated with exit code) (\d+)|ERROR: Job failed/,
      'The job script exited with an error code. The cause is above this line.', 'Look for the first error above it.', { generic: true, rank: 1 }),
    S('jenkins-fail', 'exit', 'Jenkins build failed', /^Finished: (FAILURE|UNSTABLE|ABORTED)|script returned exit code (\d+)|ERROR: script returned exit code/,
      'Jenkins reports the build result. The cause is earlier in the log.', 'Look for the first error above it.', { generic: true, rank: 1 }),
    S('build-failed', 'exit', 'Build failed', /^BUILD FAILED|^\[ERROR\] BUILD FAILURE|^FAILURE: Build failed with an exception|Error: Command failed with exit code|npm ERR! (code ELIFECYCLE|Lifecycle script .* failed|errno \d+)|^error Command failed with exit code|ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL|exited with (code|status) \d+/i,
      'The build tool reports that something failed. The cause is earlier in the log.', 'Look for the first error above it.', { generic: true, rank: 1 }),
    S('npm-log', 'exit', 'npm debug log pointer', /npm ERR! A complete log of this run can be found in|npm ERR! Log files were not written/,
      'npm wrote a debug log. This is the end of the failure, not the cause.', 'Look at the npm ERR! code line above.', { generic: true, rank: 0 }),
    S('gh-error', 'exit', 'Error annotation', /^##\[error\]|^::error/,
      'An error annotation. Its text usually repeats an error printed above.', 'Read the message; if it is just an exit code, look above.', { generic: true, rank: 1 }),
  ];

  const EXIT_CODES = {
    1: 'General error: the command failed. The reason is printed above.',
    2: 'Misuse of a command or a failed build step (also pytest: interrupted; make: target failed).',
    4: 'pytest: usage error. npm: often network or registry trouble.',
    5: 'pytest: no tests were collected.',
    124: 'timeout command: the command ran too long.',
    125: 'docker run: the Docker daemon itself failed.',
    126: 'Command found but not executable (missing execute permission).',
    127: 'Command not found: not installed or not on the PATH.',
    128: 'Invalid exit argument, or git fatal error.',
    130: 'Interrupted (Ctrl+C / SIGINT).',
    134: 'Aborted (SIGABRT): a crash or failed assertion in native code.',
    137: 'Killed (SIGKILL): almost always out of memory, or a hard timeout.',
    139: 'Segmentation fault (SIGSEGV): a native crash.',
    143: 'Terminated (SIGTERM): cancelled or timed out.',
  };

  // ------------------------------------------------------------------ cleaning and CI detection
  const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\[(?:\d{1,3};)*\d{1,3}m(?=\S)/g;
  const TS_PREFIXES = [
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z \d{2}[OE]\+? ?/,            // GitLab: 2026-11-08T10:00:00.123456Z 00O
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/,                           // GitHub Actions
    /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\] ?/,                      // Jenkins timestamper (ISO)
    /^\[?\d{2}:\d{2}:\d{2}(?:\.\d+)?\]?\s+(?=\S)/,                                  // Jenkins timestamper (time only)
    /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:[.,]\d+)?\] ?/,
  ];
  // "GitHub jobs\t step name\t 2026-…Z line" when logs are downloaded from the gh CLI
  const GH_CLI = /^[^\t]{1,200}\t[^\t]{1,200}\t(?=\d{4}-\d{2}-\d{2}T)/;

  function clean(text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const out = new Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      let l = lines[i];
      if (l.indexOf('\r') >= 0) { const parts = l.split('\r').filter(p => p.length); l = parts.length ? parts[parts.length - 1] : ''; }
      if (l.indexOf('\x1b') >= 0 || l.indexOf('[') >= 0) l = l.replace(ANSI, '');
      l = l.replace(GH_CLI, '');
      for (const re of TS_PREFIXES) { if (re.test(l)) { l = l.replace(re, ''); break; } }
      l = l.replace(/^section_(start|end):\d+:[\w.-]+(\[[^\]]*\])?\r?/, '');
      out[i] = l;
    }
    return out;
  }

  function detectCI(text) {
    const t = String(text || '').slice(0, 400000);
    const score = { github: 0, gitlab: 0, jenkins: 0, azure: 0, circleci: 0 };
    const add = (k, re, w) => { if (re.test(t)) score[k] += w; };
    add('github', /##\[(group|endgroup|error|warning)\]/, 3); add('github', /::(error|warning|group|set-output)::?/, 2);
    add('github', /\/home\/runner\/work\//, 3); add('github', /Run actions\/(checkout|setup-\w+)@/, 4); add('github', /GITHUB_(WORKSPACE|ACTIONS|REF)/, 2);
    add('github', /Current runner version:|Runner Image|Complete job name:/, 4);
    add('gitlab', /Running with gitlab-runner/, 6); add('gitlab', /section_start:\d+:/, 4); add('gitlab', /Preparing the "[\w+-]+" executor|Using Docker executor/, 4);
    add('gitlab', /ERROR: Job failed|Job succeeded/, 3); add('gitlab', /\/builds\/[\w.-]+\//, 2); add('gitlab', /CI_PROJECT_DIR|CI_COMMIT_SHA/, 2);
    add('jenkins', /^\[Pipeline\]/m, 5); add('jenkins', /Started by (user|timer|an SCM change|upstream project)/, 4); add('jenkins', /^Finished: (SUCCESS|FAILURE|UNSTABLE|ABORTED)/m, 4);
    add('jenkins', /Building in workspace|Running on .* in \/|\[WS-CLEANUP\]|\/var\/jenkins_home|\/var\/lib\/jenkins/, 3);
    add('azure', /##\[section\]Starting:|##\[section\]Finishing:/, 6); add('azure', /Agent name: |Azure Pipelines|\/home\/vsts\/work|D:\\a\\1\\s/, 3);
    add('circleci', /circleci|CIRCLE_(SHA1|BRANCH|JOB)|Spin up environment/i, 3);
    const best = Object.keys(score).sort((a, b) => score[b] - score[a])[0];
    return score[best] >= 3 ? best : 'unknown';
  }
  const CI_LABEL = { github: 'GitHub Actions', gitlab: 'GitLab CI', jenkins: 'Jenkins', azure: 'Azure Pipelines', circleci: 'CircleCI', unknown: 'Unknown CI (generic log)' };

  // ------------------------------------------------------------------ tests in logs
  const noRetry = s => s.replace(/\s+\(retry #\d+\)\s*$/, '').trim();
  const TEST_PATTERNS = [
    // [regex, framework, status (or null to use statusFn), nameFn, statusFn]
    [/^\s*[✓✔]\s+\d+\s+\[([\w-]+)\] › (.+?)\s+\(\d+(?:\.\d+)?m?s\)\s*$/, 'playwright', 'pass', m => noRetry(m[2]) + ' [' + m[1] + ']'],
    [/^\s*[✘×]\s+\d+\s+\[([\w-]+)\] › (.+?)\s+\(\d+(?:\.\d+)?m?s\)\s*$/, 'playwright', 'fail', m => noRetry(m[2]) + ' [' + m[1] + ']'],
    [/^\s+\d+\) \[([\w-]+)\] › (.+?)(?:\s+─+)?\s*$/, 'playwright', 'fail', m => noRetry(m[2]) + ' [' + m[1] + ']'],
    [/^\s*●\s+(.+? › .+?)\s*$/, 'jest', 'fail', m => m[1].split(' › ').pop()],
    [/^\s*✕\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/, 'jest', 'fail', m => m[1]],
    [/^\s*✓\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/, 'jest', 'pass', m => m[1]],
    [/^FAILED ([\w/.\-\[\]]+\.py::[^\s]+)(?: - (.*))?$/, 'pytest', 'fail', m => m[1]],
    [/^([\w/.\-]+\.py::\S+) (PASSED|FAILED|ERROR|XPASS|XFAIL|SKIPPED)\b/, 'pytest', null, m => m[1], m => (/PASS|XFAIL/.test(m[2]) ? 'pass' : /SKIP/.test(m[2]) ? 'skip' : 'fail')],
    [/^ERROR ([\w/.\-]+\.py::\S+)/, 'pytest', 'fail', m => m[1]],
    [/^\[ERROR\]\s+(\w[\w$]*)\.(\w+):\d+/, 'junit', 'fail', m => m[1] + '.' + m[2]],
    [/^\[ERROR\]\s+(\w[\w$]*)\.(\w+)\s+(?:»|Time elapsed)/, 'junit', 'fail', m => m[1] + '.' + m[2]],
    [/^(?:\[ERROR\]\s+)?(\w+)\(([\w.$]+)\)\s+Time elapsed: [\d.]+ s(?:ec)?\s+<<< (?:FAILURE|ERROR)!/, 'junit', 'fail', m => m[2].split('.').pop() + '.' + m[1]],
    [/^(?:\[ERROR\]\s+)?([\w.$]+)\.(\w+)\s+(?:--\s+)?Time elapsed: [\d.]+ s(?:ec)?\s+<<< (?:FAILURE|ERROR)!/, 'junit', 'fail', m => m[1].split('.').pop() + '.' + m[2]],
    [/^([\w.$]+) > (.+?) (FAILED|PASSED|SKIPPED)\s*$/, 'gradle', null, m => m[1].split('.').pop() + '.' + m[2].replace(/\(\)$/, ''), m => (m[3] === 'PASSED' ? 'pass' : m[3] === 'SKIPPED' ? 'skip' : 'fail')],
    [/^--- FAIL: (\S+)/, 'go', 'fail', m => m[1]],
    [/^--- PASS: (\S+)/, 'go', 'pass', m => m[1]],
    [/^\s*Failed (\S+) \[\d/, 'dotnet', 'fail', m => m[1]],
    [/^\s*Passed (\S+) \[\d/, 'dotnet', 'pass', m => m[1]],
    [/^rspec (\.\/spec\/\S+:\d+) # (.+)$/, 'rspec', 'fail', m => m[2] + ' (' + m[1] + ')'],
  ];

  function parseTests(lines) {
    const tests = [];
    const seen = {};
    let pwSection = '';
    const push = (name, status, framework, line) => {
      const key = name + '|' + status;
      if (seen[key]) return;
      seen[key] = 1;
      tests.push({ name, status, framework, line });
    };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*\d+ failed\s*$/.test(l)) { pwSection = 'fail'; continue; }
      if (/^\s*\d+ flaky\s*$/.test(l)) { pwSection = 'flaky'; continue; }
      if (/^\s*\d+ (passed|skipped|did not run|interrupted)\b/.test(l)) { pwSection = ''; continue; }
      if (pwSection) {
        const s = /^\s+\[([\w-]+)\] › (.+?)\s*$/.exec(l);
        if (s) { push(noRetry(s[2]) + ' [' + s[1] + ']', pwSection, 'playwright', i + 1); continue; }
        if (l.trim() && !/^\s/.test(l)) pwSection = '';
      }
      for (const p of TEST_PATTERNS) {
        const m = p[0].exec(l);
        if (!m) continue;
        push(p[3](m).trim(), p[2] || p[4](m), p[1], i + 1);
        break;
      }
    }
    // Failed then passed in the same log (a retry) = flaky; a test listed under "flaky" is not also failed or passed.
    const st = {};
    tests.forEach(t => { (st[t.name] = st[t.name] || {})[t.status] = t; });
    const out = [];
    const done = {};
    tests.forEach(t => {
      if (done[t.name]) return;
      const s = st[t.name];
      if (s.flaky || (s.fail && s.pass)) { done[t.name] = 1; out.push(Object.assign({}, s.flaky || s.fail, { status: 'flaky' })); return; }
      out.push(t);
    });
    return out;
  }

  // ------------------------------------------------------------------ analysis
  function analyse(text, opts) {
    opts = opts || {};
    const raw = String(text || '');
    const lines = clean(raw);
    const ci = detectCI(raw);
    const ctxN = opts.context == null ? 3 : opts.context;
    const maxMatches = opts.maxMatches || 2000;
    const matches = [];
    const bySig = {};
    let exitCode = null;
    // quick pre-filter so 100k-line logs stay fast
    const QUICK = /err|fail|fatal|exception|denied|timeout|timed out|killed|refused|reset|not found|unable|cannot|could not|invalid|no space|limit|quality|exceeded|abort|cancel|exit|unauthori|forbidden|●|✕|✖|crash|back-?off|segmentation|missing|syntax|vulnerab|would reformat|problems|lock|429|50[234]|40[134]|flaky|retry|interactable|stale|intercepted|closed|enospc|emfile|oom|signal|terminated|not permitted|permission|ssl|certificate|x509|pkix|resolve|no matching|manifest|toomanyrequests|coverage|threshold|warnings potentially|go\.sum|undefined:|cannot use|declared and not used|imported and not used|deadline|probe|rollout|helm|terraform|sonar|style issues|checkstyle|^\s*killed|engine|eresolve|gyp|^---|tests run|there were|there are|^e\s|tests:|error|passed on retry|not allowed|workflowscript|expected|dsl method|yaml|unrecognized|required property|not accessible|not supplied|hang up|no such|not known|✘|denied|eaddrinuse|in use|rate limit|too many|gateway|unavailable|shutdown signal|went offline|lost communication|e40[134]|lockfile|lock file|in sync|engine|incompatible|distribution|resolutionimpossible|could not|cannot|compil|ts\d{4}|cs\d{4}|can't resolve|segmentation|publickey|integration|expiredtoken|security token|not authorized|credentials|daemon|crashloop|imagepull|errimagepull|progress deadline|forbidden|state lock|assert|--- fail|of \d+ failed|cypresserror|operation was cancel|took longer|stuck|webpack|exit code|finished:|build failed|elifecycle|##\[error\]|::error/i;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l || l.length > 4000 || !QUICK.test(l)) continue;
      // one signature per line: the highest-ranked match wins (ties go to the earlier, more specific entry)
      let sig = null, m = null;
      for (const s of SIGNATURES) {
        if (sig && s.rank <= sig.rank) continue;
        const mm = s.re.exec(l);
        if (mm) { sig = s; m = mm; }
      }
      if (sig) {
        if (sig.id === 'gh-exit' || sig.id === 'gl-exit' || sig.id === 'jenkins-fail') {
          const code = m.slice(1).reverse().find(x => x && /^\d+$/.test(x));
          if (code != null) exitCode = +code;
        }
        const g = bySig[sig.id] || (bySig[sig.id] = { sig, count: 0, lines: [] });
        g.count++;
        if (g.lines.length < 20) g.lines.push(i + 1);
        if (matches.length < maxMatches && g.count <= 5) matches.push({ sigId: sig.id, line: i + 1, text: l.trim().slice(0, 500) });
      }
    }
    if (exitCode == null) {
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 400); i--) {
        const m = /exit (?:code|status)[: ]+(\d+)/i.exec(lines[i]);
        if (m) { exitCode = +m[1]; break; }
      }
    }

    // Root cause candidate: the earliest non-generic match, preferring higher rank within a window near the first one.
    const real = matches.filter(m => !sigById(m.sigId).generic && m.sigId !== 'flaky-marker');
    let root = null;
    if (real.length) {
      const first = real[0];
      // within 40 lines of the first error, a higher-rank signature (e.g. ENOSPC under a generic npm failure) wins
      const near = real.filter(m => m.line - first.line <= 40);
      root = near.reduce((best, m) => (sigById(m.sigId).rank > sigById(best.sigId).rank ? m : best), first);
      // but a disk/memory/auth/config failure anywhere in the log outranks a later test failure
      const severe = real.find(m => sigById(m.sigId).rank >= 10 && m.line < (root.line + 2000));
      if (severe && sigById(root.sigId).rank < 9 && severe.line !== root.line) root = sigById(severe.sigId).cat === 'test' ? root : severe;
    } else if (matches.length) {
      root = matches.find(m => sigById(m.sigId).id !== 'flaky-marker') || matches[0];
    }
    let fallback = null;
    if (!root) {
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (/\b(error|fatal|failed|failure|exception)\b/i.test(l) && !/\b(0 errors?|no errors?|errors?: 0|0 failed|failures: 0|warn(ing)?)\b/i.test(l) && !/^\s*(\+|\$|#|echo)\s/.test(l)) {
          fallback = { line: i + 1, text: l.trim().slice(0, 500) };
          break;
        }
      }
    }
    const rootInfo = root ? Object.assign({}, root, { sig: sigById(root.sigId) }) : fallback ? Object.assign({ sigId: null, sig: null }, fallback) : null;
    if (rootInfo) rootInfo.context = context(lines, rootInfo.line, ctxN + 3);
    matches.forEach(m => {
      m.context = context(lines, m.line, ctxN);
      m.role = rootInfo && m.line === rootInfo.line ? 'root' : sigById(m.sigId).generic ? 'follow-on' : rootInfo && m.line > rootInfo.line ? 'later' : 'earlier';
    });

    const tests = parseTests(lines);
    const failedTests = tests.filter(t => t.status === 'fail');
    const flakyTests = tests.filter(t => t.status === 'flaky');
    const groups = Object.keys(bySig).map(k => bySig[k]).sort((a, b) => a.lines[0] - b.lines[0]);
    const categories = {};
    groups.forEach(g => { if (g.sig.cat !== 'exit') categories[g.sig.cat] = (categories[g.sig.cat] || 0) + g.count; });
    const passed = /^Finished: SUCCESS|Job succeeded|##\[section\]Finishing:.*\n?.*succeeded/m.test(lines.slice(-60).join('\n'));
    const failedSignal = (exitCode != null && exitCode !== 0) || failedTests.length > 0 || groups.some(g => g.sig.id !== 'flaky-marker' && g.sig.id !== 'npm-log');
    const status = passed && !failedTests.length && !(exitCode > 0) ? (groups.length ? 'passed-with-warnings' : 'passed') : failedSignal ? 'failed' : 'unknown';

    const result = {
      ci, ciLabel: CI_LABEL[ci], lineCount: lines.length, exitCode, exitMeaning: exitCode != null ? (EXIT_CODES[exitCode] || (exitCode > 128 && exitCode < 160 ? 'Killed by signal ' + (exitCode - 128) + '.' : 'Non-zero exit: the command failed.')) : '',
      root: rootInfo, matches, groups: groups.map(g => ({ id: g.sig.id, cat: g.sig.cat, catLabel: CATS[g.sig.cat], title: g.sig.title, cause: g.sig.cause, fix: g.sig.fix, generic: !!g.sig.generic, count: g.count, lines: g.lines })),
      categories, tests, failedTests, flakyTests, status,
    };
    result.summary = summarise(result);
    return result;
  }

  function sigById(id) { return SIG_INDEX[id]; }
  const SIG_INDEX = {};
  SIGNATURES.forEach(s => { SIG_INDEX[s.id] = s; });

  function context(lines, lineNo, n) {
    const from = Math.max(1, lineNo - n), to = Math.min(lines.length, lineNo + n);
    const out = [];
    for (let i = from; i <= to; i++) out.push({ n: i, text: (lines[i - 1] || '').slice(0, 400), hit: i === lineNo });
    return out;
  }

  function summarise(r) {
    if (!r.root) return /^passed/.test(r.status) ?'The job passed. No failure signatures were found.' : 'No known failure pattern was found. Check the last 50 lines for the error, and that the log is complete.';
    const s = r.root.sig;
    let t = s ? s.title + ' at line ' + r.root.line + '. ' + s.cause : 'First error-like line is at ' + r.root.line + ': "' + r.root.text.slice(0, 160) + '".';
    if (r.failedTests.length) t += ' ' + r.failedTests.length + ' failed test' + (r.failedTests.length === 1 ? '' : 's') + ' listed.';
    if (r.flakyTests.length) t += ' ' + r.flakyTests.length + ' test' + (r.flakyTests.length === 1 ? '' : 's') + ' passed only on retry.';
    if (r.exitCode != null) t += ' Exit code ' + r.exitCode + ': ' + r.exitMeaning;
    return t;
  }

  // ------------------------------------------------------------------ JUnit XML (no DOMParser)
  function decodeEntities(s) {
    return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()];
    });
  }
  function attrs(tag) {
    const a = {};
    const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(tag))) a[m[1]] = decodeEntities(m[3] != null ? m[3] : m[4]);
    return a;
  }

  function parseJUnitXML(xml) {
    const s = String(xml || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, c) => c.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    if (!/<testsuites?\b|<testcase\b/.test(s)) throw new Error('This does not look like JUnit XML (no <testsuite> or <testcase>).');
    const cases = [];
    const suites = [];
    // walk tags in order, tracking the current testsuite name
    const tagRe = /<(\/?)(testsuite|testcase|failure|error|skipped|flakyFailure|flakyError|rerunFailure|rerunError)\b([^>]*?)(\/?)>/g;
    const suiteStack = [];
    let cur = null, m;
    while ((m = tagRe.exec(s))) {
      const closing = m[1] === '/', name = m[2], selfClose = m[4] === '/';
      if (name === 'testsuite') {
        if (closing) suiteStack.pop();
        else { const a = attrs(m[3]); suites.push(a); if (!selfClose) suiteStack.push(a.name || ''); }
        continue;
      }
      if (name === 'testcase') {
        if (closing) { if (cur) cases.push(cur); cur = null; continue; }
        const a = attrs(m[3]);
        const c = { suite: suiteStack[suiteStack.length - 1] || '', classname: a.classname || a.class || '', name: a.name || '(unnamed)', time: parseFloat(a.time) || 0, status: 'pass', message: '', type: '', flaky: false, file: a.file || '' };
        if (selfClose) cases.push(c); else cur = c;
        continue;
      }
      if (!cur || closing) continue;
      const a = attrs(m[3]);
      let body = '';
      if (!selfClose) { const end = s.indexOf('</' + name, tagRe.lastIndex); if (end > 0) body = decodeEntities(s.slice(tagRe.lastIndex, end)).trim(); }
      if (name === 'failure' || name === 'error') { cur.status = name === 'failure' ? 'fail' : 'error'; cur.message = (a.message || body.split('\n')[0] || '').slice(0, 500); cur.type = a.type || ''; cur.detail = body.slice(0, 4000); }
      else if (name === 'skipped') { if (cur.status === 'pass') cur.status = 'skip'; cur.message = a.message || ''; }
      else if (/^flaky/.test(name)) { cur.flaky = true; if (!cur.message) cur.message = (a.message || body.split('\n')[0] || '').slice(0, 500); }
      else if (/^rerun/.test(name)) { cur.rerunFailed = true; if (!cur.message) cur.message = (a.message || body.split('\n')[0] || '').slice(0, 500); }
    }
    if (cur) cases.push(cur);
    const count = st => cases.filter(c => c.status === st).length;
    return {
      suites: suites.map(x => x.name).filter(Boolean), cases,
      total: cases.length, passed: count('pass'), failed: count('fail') + count('error'), skipped: count('skip'), flaky: cases.filter(c => c.flaky).length,
      time: cases.reduce((a, c) => a + c.time, 0),
    };
  }
  const caseKey = c => (c.classname ? c.classname.split('.').pop() + '.' : '') + c.name;

  // ------------------------------------------------------------------ multi-run
  function looksLikeJUnit(text) { return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(testsuites|testsuite)\b/.test(String(text || '').slice(0, 4000)); }

  function multiRun(runs) {
    const out = { runs: [], tests: [], flaky: [], recurring: [], trend: [], categories: [] };
    const hist = {};
    const catSet = {};
    (runs || []).forEach((run, idx) => {
      const isXml = run.kind === 'junit' || (run.kind !== 'log' && looksLikeJUnit(run.text));
      const info = { name: run.name || 'Run ' + (idx + 1), kind: isXml ? 'junit' : 'log', passed: 0, failed: 0, skipped: 0, flaky: 0, root: null, categories: {}, error: '' };
      let tests = [];
      try {
        if (isXml) {
          const j = parseJUnitXML(run.text);
          tests = j.cases.map(c => ({ name: caseKey(c), status: c.status === 'error' ? 'fail' : c.status === 'pass' && c.flaky ? 'flaky' : c.status, message: c.message }));
          info.categories = { test: j.failed };
        } else {
          const a = analyse(run.text, { maxMatches: 500 });
          tests = a.tests.map(t => ({ name: t.name, status: t.status, message: '' }));
          info.root = a.root ? { line: a.root.line, title: a.root.sig ? a.root.sig.title : 'Unrecognised error', text: a.root.text, cat: a.root.sig ? a.root.sig.cat : 'other' } : null;
          info.categories = a.categories;
          info.status = a.status;
        }
      } catch (e) { info.error = e.message; }
      tests.forEach(t => {
        const h = hist[t.name] || (hist[t.name] = { name: t.name, statuses: new Array((runs || []).length).fill(null), messages: [] });
        const prev = h.statuses[idx];
        // within one run a test can appear twice (retries): fail then pass = flaky
        h.statuses[idx] = prev && prev !== t.status && (prev === 'fail' || t.status === 'fail') ? 'flaky' : t.status;
        if (t.message && h.messages.length < 3 && h.messages.indexOf(t.message) < 0) h.messages.push(t.message);
      });
      Object.keys(hist).forEach(k => { const st = hist[k].statuses[idx]; if (st === 'pass') info.passed++; else if (st === 'fail') info.failed++; else if (st === 'skip') info.skipped++; else if (st === 'flaky') info.flaky++; });
      Object.keys(info.categories).forEach(c => { catSet[c] = 1; });
      out.runs.push(info);
    });
    const n = out.runs.length;
    out.tests = Object.keys(hist).map(k => {
      const h = hist[k];
      const fails = h.statuses.filter(s => s === 'fail').length;
      const passes = h.statuses.filter(s => s === 'pass').length;
      const flakyRuns = h.statuses.filter(s => s === 'flaky').length;
      let flips = 0, prev = null;
      h.statuses.forEach(s => { if (s === 'pass' || s === 'fail') { if (prev && s !== prev) flips++; prev = s; } });
      // One switch from pass to fail that stays failing is a new break, and fail → pass is a fix; neither is flakiness.
      const flaky = flakyRuns > 0 || flips >= 2;
      const seenRuns = h.statuses.filter(Boolean).length;
      let brokenSince = null, fixedIn = null;
      if (!flaky && flips === 1) {
        const idx = h.statuses.map((s, i) => (s === 'pass' || s === 'fail' ? i : -1)).filter(i => i >= 0);
        let k = idx.length - 1;
        while (k > 0 && h.statuses[idx[k - 1]] === h.statuses[idx[k]]) k--;
        if (h.statuses[idx[idx.length - 1]] === 'fail') brokenSince = idx[k]; else fixedIn = idx[k];
      }
      return { name: h.name, statuses: h.statuses, fails, passes, flakyRuns, flips, flaky, brokenSince, fixedIn, failRate: seenRuns ? Math.round((fails + flakyRuns) / seenRuns * 100) : 0, alwaysFails: fails > 0 && fails === seenRuns, messages: h.messages };
    });
    out.flaky = out.tests.filter(t => t.flaky).sort((a, b) => (b.flips + b.flakyRuns) - (a.flips + a.flakyRuns) || b.fails - a.fails);
    out.recurring = out.tests.filter(t => t.fails + t.flakyRuns > 0).sort((a, b) => (b.fails + b.flakyRuns) - (a.fails + a.flakyRuns) || a.name.localeCompare(b.name));
    out.categories = Object.keys(catSet).filter(c => c !== 'exit');
    out.trend = out.runs.map(r => { const o = { run: r.name }; out.categories.forEach(c => { o[c] = r.categories[c] || 0; }); return o; });
    out.flakyRate = out.tests.length ? Math.round(out.flaky.length / out.tests.length * 1000) / 10 : 0;
    out.runCount = n;
    return out;
  }

  // ------------------------------------------------------------------ Markdown export
  function toMarkdown(r, name) {
    const L = [];
    L.push('### CI failure summary' + (name ? ': ' + name : ''), '');
    L.push('- **CI:** ' + r.ciLabel + ' · **Lines:** ' + r.lineCount + (r.exitCode != null ? ' · **Exit code:** ' + r.exitCode : ''));
    if (r.root) {
      L.push('- **Root cause candidate (line ' + r.root.line + '):** ' + (r.root.sig ? r.root.sig.title : 'unrecognised error'));
      L.push('', '```', r.root.text, '```', '');
      if (r.root.sig) { L.push('**Why:** ' + r.root.sig.cause, '', '**Fix:** ' + r.root.sig.fix, ''); }
    } else L.push('- No known failure pattern found.', '');
    const other = r.groups.filter(g => !g.generic && (!r.root || !r.root.sig || g.id !== r.root.sig.id));
    if (other.length) { L.push('**Other signals:**', ''); other.slice(0, 10).forEach(g => L.push('- ' + g.title + ' (' + g.catLabel + ') ×' + g.count + ', first at line ' + g.lines[0])); L.push(''); }
    if (r.failedTests.length) { L.push('**Failed tests (' + r.failedTests.length + '):**', ''); r.failedTests.slice(0, 25).forEach(t => L.push('- `' + t.name + '`')); if (r.failedTests.length > 25) L.push('- …and ' + (r.failedTests.length - 25) + ' more'); L.push(''); }
    if (r.flakyTests.length) { L.push('**Passed only on retry:** ' + r.flakyTests.map(t => '`' + t.name + '`').join(', '), ''); }
    L.push('_Analysed in the browser with CI/CD Failure Detective (pawansinha.com.au/tools/ci-failure-detective/)._');
    return L.join('\n');
  }

  function multiToMarkdown(m) {
    const L = ['### Test history across ' + m.runCount + ' runs', ''];
    L.push('- **Tests seen:** ' + m.tests.length + ' · **Flaky:** ' + m.flaky.length + ' (' + m.flakyRate + '%) · **Failing at least once:** ' + m.recurring.length, '');
    const icon = s => (s === 'pass' ? '✅' : s === 'fail' ? '❌' : s === 'flaky' ? '🔁' : s === 'skip' ? '⏭' : '·');
    if (m.flaky.length) {
      L.push('**Flaky tests**', '', '| Test | History | Fails |', '|---|---|---|');
      m.flaky.slice(0, 20).forEach(t => L.push('| `' + t.name.replace(/\|/g, '/') + '` | ' + t.statuses.map(icon).join(' ') + ' | ' + (t.fails + t.flakyRuns) + '/' + t.statuses.filter(Boolean).length + ' |'));
      L.push('');
    }
    const hard = m.recurring.filter(t => !t.flaky);
    if (hard.length) {
      L.push('**Failing, not flaky**', '', '| Test | History | Fails |', '|---|---|---|');
      hard.slice(0, 20).forEach(t => L.push('| `' + t.name.replace(/\|/g, '/') + '`' + (t.brokenSince != null ? ' (since run ' + (t.brokenSince + 1) + ')' : '') + ' | ' + t.statuses.map(icon).join(' ') + ' | ' + t.fails + '/' + t.statuses.filter(Boolean).length + ' |'));
      L.push('');
    }
    const roots = m.runs.filter(r => r.root);
    if (roots.length) { L.push('**Root cause per run**', ''); roots.forEach(r => L.push('- ' + r.name + ': ' + r.root.title + ' (line ' + r.root.line + ')')); L.push(''); }
    L.push('_Analysed in the browser with CI/CD Failure Detective (pawansinha.com.au/tools/ci-failure-detective/)._');
    return L.join('\n');
  }

  const api = { clean, detectCI, analyse, parseTests, parseJUnitXML, multiRun, looksLikeJUnit, toMarkdown, multiToMarkdown, SIGNATURES, CATS, CI_LABEL, EXIT_CODES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CIDetective = api;
})(typeof self !== 'undefined' ? self : this);
