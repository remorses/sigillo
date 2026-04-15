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
