// Client component for the device authorization flow (RFC 8628).
// Two steps:
// 1. Enter user code → validate via authClient.device()
// 2. Approve or deny → authClient.device.approve() / .deny()
// User must be authenticated before they can approve.

"use client"

import { useState } from "react"
import { authClient } from "../auth-client.ts"

export function DeviceFlow() {
  const [step, setStep] = useState<'enter' | 'approve'>('enter')
  const [userCode, setUserCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState<'approved' | 'denied' | null>(null)

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      // Strip dashes and uppercase for consistent formatting
      const formatted = userCode.trim().replace(/-/g, '').toUpperCase()
      const { data, error: err } = await authClient.device({
        query: { user_code: formatted },
      })
      if (err || !data) {
        setError('Invalid or expired code. Please try again.')
        setLoading(false)
        return
      }
      setUserCode(formatted)
      setStep('approve')
    } catch {
      setError('Invalid or expired code. Please try again.')
    }
    setLoading(false)
  }

  async function handleApprove() {
    setLoading(true)
    setError(null)
    try {
      await authClient.device.approve({ userCode })
      setDone('approved')
    } catch {
      setError('Failed to approve. Make sure you are signed in.')
    }
    setLoading(false)
  }

  async function handleDeny() {
    setLoading(true)
    setError(null)
    try {
      await authClient.device.deny({ userCode })
      setDone('denied')
    } catch {
      setError('Failed to deny device.')
    }
    setLoading(false)
  }

  if (done) {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <div className="text-center max-w-sm">
          <h1 className="text-2xl font-bold mb-2">
            {done === 'approved' ? 'Device Approved' : 'Device Denied'}
          </h1>
          <p className="text-muted-foreground">
            {done === 'approved'
              ? 'You can close this page. Your CLI or agent is now authenticated.'
              : 'The device authorization request was denied.'}
          </p>
        </div>
      </div>
    )
  }

  if (step === 'approve') {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <div className="text-center max-w-sm">
          <h1 className="text-2xl font-bold mb-2">Authorize Device</h1>
          <p className="text-muted-foreground mb-2">
            A device is requesting access to your account.
          </p>
          <p className="font-mono text-lg mb-6 tracking-[0.15em]">{userCode}</p>
          {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
          <div className="flex gap-3 justify-center">
            <button
              onClick={handleApprove}
              disabled={loading}
              className="h-10 px-6 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
            >
              {loading ? 'Processing…' : 'Approve'}
            </button>
            <button
              onClick={handleDeny}
              disabled={loading}
              className="h-10 px-6 rounded-lg bg-destructive text-destructive-foreground font-semibold hover:bg-destructive/90 transition-colors cursor-pointer disabled:opacity-50"
            >
              Deny
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-center items-center min-h-[60vh]">
      <div className="text-center max-w-sm">
        <h1 className="text-2xl font-bold mb-2">Device Login</h1>
        <p className="text-muted-foreground mb-6">Enter the code shown on your CLI or agent:</p>
        {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
        <form onSubmit={handleVerify} className="flex flex-col gap-4">
          <input
            value={userCode}
            onChange={(e) => setUserCode(e.target.value)}
            placeholder="ABCD-EFGH"
            maxLength={12}
            className="h-12 rounded-lg border border-input bg-background px-4 text-center text-2xl font-mono tracking-[0.25em] uppercase focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button
            type="submit"
            disabled={loading || !userCode.trim()}
            className="h-10 rounded-lg bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors cursor-pointer disabled:opacity-50"
          >
            {loading ? 'Verifying…' : 'Verify Code'}
          </button>
        </form>
      </div>
    </div>
  )
}
