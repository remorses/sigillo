// Browser side of passkeys: the WebAuthn prompts, and the two Settings cards
// (which secrets need approval, and the user's passkeys).
//
// confirmWithPasskey() asks the server for a challenge bound to one exact
// action, shows the browser passkey prompt, and returns the signed assertion.
// The caller passes it to the server action that performs that action.

'use client'

import { useState, useTransition } from 'react'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { FingerprintIcon, ShieldCheckIcon, XIcon } from 'lucide-react'
import { useLoaderData } from 'spiceflow/react'
import { Button } from 'sigillo-app/src/components/ui/button'
import { NativeSelect } from 'sigillo-app/src/components/ui/native-select'
import { TimeAgo } from 'sigillo-app/src/components/ui/time-ago'
import { cn } from 'sigillo-app/src/lib/utils'
import { getEnvColor } from 'sigillo-app/src/components/environments-table'
import {
  addSecretApprovalAction,
  finishPasskeyRegistrationAction,
  removePasskeyAction,
  removeSecretApprovalAction,
  setReadApprovalAction,
  startPasskeyAssertionAction,
  startPasskeyRegistrationAction,
  unlockEnvironmentAction,
} from '../approval-actions.ts'
import type { PasskeyIntent } from '../passkey.ts'

export async function confirmWithPasskey(intent: PasskeyIntent) {
  const { options } = await startPasskeyAssertionAction({ intent })
  return startAuthentication({ optionsJSON: options })
}

function defaultPasskeyName() {
  const agent = navigator.userAgent
  if (/iPhone/.test(agent)) return 'iPhone'
  if (/iPad/.test(agent)) return 'iPad'
  if (/Android/.test(agent)) return 'Android'
  if (/Mac/.test(agent)) return 'Mac'
  if (/Windows/.test(agent)) return 'Windows PC'
  return 'Passkey'
}

// The first passkey needs no confirmation. Every later one is confirmed with
// an existing passkey, so a stolen session cannot add its own.
export async function enrollPasskey({ hasPasskey }: { hasPasskey: boolean }) {
  const assertion = hasPasskey ? await confirmWithPasskey({ kind: 'add-passkey' }) : undefined
  const { options } = await startPasskeyRegistrationAction({ assertion })
  const response = await startRegistration({ optionsJSON: options })
  return finishPasskeyRegistrationAction({ response, name: defaultPasskeyName() })
}

// Reveals the protected secrets of one environment to this browser session
// for 1 minute. Returns their values (name -> value) so the caller can finish
// a copy or download right away; the page also reloads with them.
export async function unlockWithPasskey(environmentId: string) {
  const assertion = await confirmWithPasskey({ kind: 'unlock', environmentId })
  const { secrets } = await unlockEnvironmentAction({ environmentId, assertion })
  return new Map(secrets.map((secret) => [secret.name, secret.value]))
}

// The browser throws NotAllowedError when the user closes the prompt.
export function passkeyErrorMessage(error: unknown) {
  if (error instanceof Error && error.name === 'NotAllowedError') return 'Passkey prompt was cancelled.'
  return error instanceof Error ? error.message : 'Something went wrong'
}

const PROTECTION_LEVEL = { off: 0, selected: 1, all: 2 } as const
type ReadApproval = keyof typeof PROTECTION_LEVEL

function isReadApproval(value: string): value is ReadApproval {
  return value in PROTECTION_LEVEL
}

export function ApprovalsSection() {
  const { approvalEnvironments, secretNames, passkeys, role } = useLoaderData('/dash/projects/:projectId/settings')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const isAdmin = role === 'admin'
  const hasPasskey = passkeys.length > 0

  function run(action: () => Promise<unknown>) {
    setError(null)
    startTransition(async () => {
      try {
        // Protection can only be raised by someone who can also approve.
        if (!hasPasskey) await enrollPasskey({ hasPasskey: false })
        await action()
      } catch (e) {
        setError(passkeyErrorMessage(e))
      }
    })
  }

  return (
    <div className="rounded-lg border border-border">
      <div className="p-5">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <ShieldCheckIcon className="size-5" />
          Approvals
        </h2>
        <p className="text-muted-foreground text-sm mt-2">
          Require a passkey approval before a CLI, agent or token reads secrets.
          {!isAdmin && ' Only admins can change this.'}
        </p>
        {error && <p className="text-sm text-destructive mt-2">{error}</p>}
      </div>
      {approvalEnvironments.map((env) => {
        const available = secretNames.filter((name) => !env.protectedNames.includes(name))
        return (
          <div key={env.id} className="border-t border-border px-5 py-3.5 bg-muted/30 last:rounded-b-lg">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <span className={cn('size-2 shrink-0 rounded-full', getEnvColor(env.name, env.slug))} />
                  <span className="truncate">{env.name}</span>
                </p>
                {env.readApproval === 'all' && (
                  <p className="text-xs text-muted-foreground mt-0.5 ml-4">Every secret, and any added later</p>
                )}
              </div>
              <NativeSelect
                aria-label={`Approval for ${env.name}`}
                className="w-44 shrink-0"
                disabled={!isAdmin || isPending}
                value={env.readApproval}
                onChange={(e) => {
                  const next = e.currentTarget.value
                  if (!isReadApproval(next) || next === env.readApproval) return
                  const lowering = PROTECTION_LEVEL[next] < PROTECTION_LEVEL[env.readApproval]
                  run(async () => {
                    const assertion = lowering
                      ? await confirmWithPasskey({ kind: 'set-read-approval', environmentId: env.id, readApproval: next })
                      : undefined
                    await setReadApprovalAction({ environmentId: env.id, readApproval: next, assertion })
                  })
                }}
              >
                <option value="off">Off</option>
                <option value="selected">Selected secrets</option>
                <option value="all">All secrets</option>
              </NativeSelect>
            </div>
            {env.readApproval === 'selected' && (
              <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                {env.protectedNames.map((name) => (
                  <span key={name} className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background pl-2 pr-1 mono-sm text-xs">
                    <span className="max-w-56 truncate">{name}</span>
                    {isAdmin && (
                      <button
                        type="button"
                        disabled={isPending}
                        aria-label={`Stop requiring approval for ${name}`}
                        className="flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground cursor-pointer"
                        onClick={() => run(async () => {
                          const assertion = await confirmWithPasskey({ kind: 'remove-secret-approval', environmentId: env.id, name })
                          await removeSecretApprovalAction({ environmentId: env.id, name, assertion })
                        })}
                      >
                        <XIcon className="size-3" />
                      </button>
                    )}
                  </span>
                ))}
                {isAdmin && available.length > 0 && (
                  <NativeSelect
                    aria-label={`Add a protected secret to ${env.name}`}
                    size="sm"
                    disabled={isPending}
                    value=""
                    onChange={(e) => {
                      const name = e.currentTarget.value
                      if (name) run(() => addSecretApprovalAction({ environmentId: env.id, name }))
                    }}
                  >
                    <option value="">+ Add secret</option>
                    {available.map((name) => <option key={name} value={name}>{name}</option>)}
                  </NativeSelect>
                )}
                {env.protectedNames.length === 0 && available.length === 0 && (
                  <p className="text-xs text-muted-foreground">This project has no secrets yet.</p>
                )}
              </div>
            )}
          </div>
        )
      })}
      {approvalEnvironments.length === 0 && (
        <div className="border-t border-border px-5 py-3.5 bg-muted/30 rounded-b-lg text-sm text-muted-foreground">
          This project has no environments.
        </div>
      )}
    </div>
  )
}

export function PasskeysSection() {
  const { passkeys } = useLoaderData('/dash/projects/:projectId/settings')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function run(action: () => Promise<unknown>) {
    setError(null)
    startTransition(async () => {
      try {
        await action()
      } catch (e) {
        setError(passkeyErrorMessage(e))
      }
    })
  }

  return (
    <div className="rounded-lg border border-border">
      <div className="p-5">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <FingerprintIcon className="size-5" />
          Passkeys
        </h2>
        <p className="text-muted-foreground text-sm mt-2">
          Your passkeys approve requests on this domain. Touch ID, a phone or a security key.
        </p>
        {error && <p className="text-sm text-destructive mt-2">{error}</p>}
      </div>
      {passkeys.map((passkey) => (
        <div key={passkey.id} className="border-t border-border px-5 py-3.5 bg-muted/30 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{passkey.name}</p>
            <p className="text-xs text-muted-foreground">
              Added <TimeAgo ts={passkey.createdAt} />
              {passkey.lastUsedAt != null && <> · used <TimeAgo ts={passkey.lastUsedAt} /></>}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => run(async () => {
              const assertion = await confirmWithPasskey({ kind: 'remove-passkey', passkeyId: passkey.id })
              await removePasskeyAction({ passkeyId: passkey.id, assertion })
            })}
          >
            Remove
          </Button>
        </div>
      ))}
      <div className="border-t border-border px-5 py-3.5 bg-muted/30 rounded-b-lg flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          {passkeys.length > 0
            ? 'Adding or removing a passkey asks for an existing one.'
            : 'Add one before you require approval, so you can approve requests.'}
        </p>
        <Button
          className="w-full sm:w-auto"
          loading={isPending}
          onClick={() => run(() => enrollPasskey({ hasPasskey: passkeys.length > 0 }))}
        >
          Add passkey
        </Button>
      </div>
    </div>
  )
}
