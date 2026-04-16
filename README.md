<div align='center'>
    <br/>
    <br/>
    <h3>sigillo</h3>
    <p>Secrets management platform for humans & agents. The nemesis of your .env files</p>
    <br/>
    <br/>
</div>

Sigillo is a website & cli that let you store, manage and share secrets. It is an alternative to using `.env` files that is in the cloud. Instead of reading from .env file you just prefix your commands with `sigillo run -- next dev`. This makes your secrets available to the process without storing anything locally.

Sigillo will remove secrets from the process output so that they don't end up in your agents context or in some data center. Agents can't read your secrets as easily as before and will never do so by mistake.

## Install the CLI

If you are hosting the app yourself, it serves a curl installer at `/install.sh`.

```bash
curl -fsSL https://sigillo.dev/install.sh | bash
```

The installer downloads the latest GitHub release binary for your platform and installs it into `~/.sigillo/bin`.

## Integrations

### Upload to Cloudflare workers

```sh
sigillo run -c production --mount .env.prod --mount-format env -- wrangler secret bulk .env.prod
```

### Sync secrets to Vercel

`vercel env add` only uploads one variable at a time, so Sigillo exposes an
`xargs` download format made for piping into it.

```sh
sigillo secrets download --format xargs | xargs -0 -n2 sh -c 'printf %s "$2" | vercel env add "$1" production --force' sh
```

Add `--sensitive` if you want Vercel to mark the uploaded values as sensitive.

```sh
sigillo secrets download --format xargs | xargs -0 -n2 sh -c 'printf %s "$2" | vercel env add "$1" production --sensitive --force' sh
```
