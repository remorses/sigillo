// Client component for the device authorization flow (RFC 8628).
// Two steps: validate the code, then require an explicit Approve click.
// Never auto-approve: /device?user_code=X links can be sent by an attacker
// who started the login (RFC 8628 §5.4 remote phishing), so the user must
// see a warning and confirm they started the login themselves.

"use client"

import { useState, useTransition } from "react"
import { z } from "zod"
import { parseFormData } from "spiceflow"
import { ErrorBoundary } from "spiceflow/react"
import { Button } from "sigillo-app/src/components/ui/button"
import { Input } from "sigillo-app/src/components/ui/input"
import { authClient } from "../auth-client.ts"

const codeSchema = z.object({
  userCode: z.string().trim().min(1, 'Enter the code shown in your terminal'),
})
const codeFields = codeSchema.keyof().enum

export function DeviceFlow({ initialCode = '' }: { initialCode?: string }) {
  const [step, setStep] = useState<
    | { kind: 'enter' }
    | { kind: 'confirm'; userCode: string }
    | { kind: 'done'; approved: boolean }
  >({ kind: 'enter' })
  const [decisionError, setDecisionError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function decide(approve: boolean) {
    if (step.kind !== 'confirm') return
    startTransition(async () => {
      const { error } = await (approve
        ? authClient.device.approve({ userCode: step.userCode })
        : authClient.device.deny({ userCode: step.userCode })
      ).catch(() => ({ error: true }))
      if (error) {
        setDecisionError('Invalid or expired code. Start the login again and enter the new code.')
        setStep({ kind: 'enter' })
        return
      }
      setStep({ kind: 'done', approved: approve })
    })
  }

  if (step.kind === 'done') {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <div className="text-center text-balance max-w-sm">
          <h1 className="text-2xl font-bold mb-2">
            {step.approved ? 'Device Approved' : 'Device Denied'}
          </h1>
          <p className="text-muted-foreground">
            {step.approved
              ? 'You can close this page. Your CLI or agent is now authenticated.'
              : 'The login request was rejected. You can close this page.'}
          </p>
        </div>
      </div>
    )
  }

  if (step.kind === 'confirm') {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <div className="text-center text-balance max-w-sm flex flex-col gap-4">
          <h1 className="text-2xl font-bold">Approve this login?</h1>
          <p className="text-3xl mono-sm tracking-[0.25em]">{step.userCode.replace(/^(.{4})(.{4})$/, '$1-$2')}</p>
          <p className="text-sm text-muted-foreground">
            A CLI or agent is asking for full access to your Sigillo account and secrets.
            Approve only if <strong>you</strong> started this login and the code above matches
            the one shown in your own terminal. If someone sent you this link, deny it.
          </p>
          <div className="flex gap-3 justify-center">
            <Button type="button" variant="outline" size="lg" disabled={pending} onClick={() => decide(false)}>
              Deny
            </Button>
            <Button type="button" size="lg" loading={pending} disabled={pending} onClick={() => decide(true)}>
              Approve
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-center items-center min-h-[60vh]">
      <div className="text-center text-balance max-w-sm">
        <h1 className="text-2xl font-bold mb-2">Device Login</h1>
        <p className="text-muted-foreground mb-6">Enter the code shown on your CLI or agent:</p>
        {decisionError && <p className="text-red-500 text-sm mb-4">{decisionError}</p>}
        <ErrorBoundary
          above
          fallback={<ErrorBoundary.ErrorMessage className="text-red-500 text-sm mb-4" />}
        >
          <form
            className="flex flex-col gap-4"
            action={async (formData: FormData) => {
              const userCode = parseFormData(codeSchema, formData).userCode.replace(/-/g, '').toUpperCase()
              const { data, error } = await authClient.device({ query: { user_code: userCode } })
                .catch(() => ({ data: null, error: true }))
              if (error || !data) throw new Error('Invalid or expired code. Please try again.')
              setDecisionError(null)
              setStep({ kind: 'confirm', userCode })
            }}
          >
            <Input
              name={codeFields.userCode}
              defaultValue={decisionError ? '' : initialCode}
              placeholder="ABCD-EFGH"
              maxLength={12}
              required
              className="h-12 text-center text-2xl mono-sm tracking-[0.25em] uppercase"
            />
            <Button type="submit" size="lg">Continue</Button>
          </form>
        </ErrorBoundary>
      </div>
    </div>
  )
}
