# pi-crof

A minimal pi extension that adds the **CrofAI** model provider via an OpenAI-compatible API.

## Files

- `index.ts` — registers the `crof` provider and model list.
- `test.ts` — integration checks (`/models`, chat completions, streaming, reasoning, `/usage_api/`).
- `.gitleaks.toml` — secret scanning rules.

## Install via git

Install globally:

```bash
pi install git:git@github.com:ZoRDoK/pi-crof.git
```

Install for current project only:

```bash
pi install -l git:git@github.com:ZoRDoK/pi-crof.git
```

## API key

Supported sources (in priority order):

1. `CROF_API_KEY` environment variable
2. `~/.pi/agent/auth.json` → `crof.key`

Example `auth.json` fragment:

```json
{
  "crof": {
    "type": "api_key",
    "key": "nahcrof_..."
  }
}
```

## Usage

In pi:

```text
/model crof/deepseek-v4-flash
```

## Run tests

```bash
git clone git@github.com:ZoRDoK/pi-crof.git
cd pi-crof
npx tsx test.ts
```

## Secret scan (gitleaks)

```bash
cd pi-crof
gitleaks dir . --config .gitleaks.toml
```

## Notes

- Do not commit real API keys to the repository.
- Keep local secrets in env vars or `~/.pi/agent/auth.json`.
