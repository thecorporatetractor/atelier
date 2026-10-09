# Privacy policy

studiolo is a Claude Code plugin that runs on your machine. Its author runs no server and collects nothing: no analytics, no telemetry, no accounts.

## What leaves your machine

Only small model calls to Haiku (or the observer model you pick), made through Claude Code's own model calls. They go to the same API, account and provider your Claude Code session already uses, under that provider's terms and privacy policy. studiolo holds no key and opens no other connection. The README's "What it sends, and where" section lists exactly what each call carries. Turn the Observer setting off in `/config` and nothing is sent.

## What stays on your machine

studiolo keeps daily usage totals, short summaries of past sessions, your view choices and the progress of your other open sessions in its own Claude Code plugin store, on your machine. To remove them, uninstall the plugin and delete its store files under `~/.claude/plugins/store/`.

## What it never reads

No credentials, keys, environment variables or files of yours.

## Contact

Open an issue at https://github.com/thecorporatetractor/studiolo/issues.
