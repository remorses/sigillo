// Page-width hero with an ASCII VideoBackgroundShader, serif title, and two CTAs.
'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { VideoBackgroundShader } from '@holocron.so/vite/mdx'
import { buttonVariants } from './ui/button.tsx'

const HERO_FONT = "'IvarText', serif"
const GITHUB_URL = 'https://github.com/remorses/sigillo'

// Shader color is a WebGL uniform, so CSS dark: variants cannot reach it.
// Colors sit close to the page background so the title keeps contrast.
const DOT_COLOR_LIGHT = '#72c29c'
const DOT_COLOR_DARK = '#4a9a75'

function subscribeToThemeClass(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox='0 0 24 24' fill='currentColor'>
      <path d='M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z' />
      <path d='M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z' />
      <path d='M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z' />
      <path d='M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z' />
    </svg>
  )
}

export function HeroSection() {
  const [fontsReady, setFontsReady] = useState(false)
  const isDark = useSyncExternalStore(
    subscribeToThemeClass,
    () => document.documentElement.classList.contains('dark'),
    () => false,
  )

  useEffect(() => {
    const timeout = setTimeout(() => setFontsReady(true), 3000)
    void document.fonts.ready.then(() => setFontsReady(true))
    return () => clearTimeout(timeout)
  }, [])

  return (
    <div className='relative mt-4 lg:mt-8 mb-6 lg:mb-10 w-full rounded-xl flex flex-col items-center overflow-hidden'>
      <VideoBackgroundShader
        src='/assets/hero-bg.mp4'
        className='absolute inset-0 w-full h-full'
        dotStyle='ascii'
        dotColor={isDark ? DOT_COLOR_DARK : DOT_COLOR_LIGHT}
        dotSize={9}
        minDotSize={1}
        dotMargin={1}
        animSpeed={3}
        gamma={0.8}
        enableMask={false}
        fluidStrength={0.2}
        fluidCurl={80}
      />

      {/* Soft background scrim behind the title/CTAs so text stays readable over glyphs */}
      <div
        aria-hidden
        className='absolute inset-0 z-[1] pointer-events-none'
        style={{
          background:
            'radial-gradient(ellipse 45% 40% at 50% 42%, color-mix(in srgb, var(--background) 85%, transparent) 0%, color-mix(in srgb, var(--background) 60%, transparent) 50%, transparent 100%)',
        }}
      />

      <div
        className='relative z-[2] flex flex-col items-center justify-center text-center max-w-[820px] w-full px-5 pt-16 sm:pt-24 pb-20 lg:pb-[160px] gap-6'
        style={{
          opacity: fontsReady ? 1 : 0,
          transition: 'opacity 0.3s cubic-bezier(0.23, 1, 0.32, 1)',
        }}
      >
        <h1
          className='flex flex-col items-center leading-none text-[36px] sm:text-[44px] md:text-[52px] text-foreground'
          style={{ fontFamily: HERO_FONT }}
        >
          <span>Secrets manager,</span>
          <span>open source Doppler alternative</span>
        </h1>

        <div className='flex gap-3 flex-wrap justify-center'>
          <a href='/login?redirect=/dash' className={buttonVariants({ size: 'lg', className: 'no-underline gap-2.5' })}>
            <GoogleIcon className='size-[16px]' />
            Login with Google
          </a>
          <a
            href={GITHUB_URL}
            target='_blank'
            rel='noopener noreferrer'
            className={buttonVariants({ variant: 'ghost', size: 'lg', className: 'no-underline' })}
          >
            GitHub Repo ↗
          </a>
        </div>
      </div>
    </div>
  )
}
