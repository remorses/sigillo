/**
 * Full-bleed hero with DottedVideoBackground (Three.js fluid sim), serif title,
 * login CTA, and links.
 *
 * Breaks out of the Above column constraint via w-screen + negative margin
 * (same pattern as holocron's own hero-section.tsx and kimaki's hero).
 *
 * Dark mode: primary-colored dots on near-black background.
 * Light mode: video is CSS-inverted, dots blend with light background.
 * Gradient overlays use var(--background) so they adapt to theme automatically.
 */
'use client'

import { ArrowDown } from 'lucide-react'
import { preload } from 'react-dom'
import { DottedVideoBackground } from './dotted-video-background.tsx'


const HERO_FONT_URL =
  'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@1,400;1,500&display=swap'

function GithubIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' fill='currentColor'>
      <path d='M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z' />
    </svg>
  )
}

function XIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' fill='currentColor'>
      <path d='M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z' />
    </svg>
  )
}

// Gradient overlays using var(--background) for theme-adaptive blending.
const TOP_GRADIENT = [
  'linear-gradient(to bottom,',
  'var(--background) 0%,',
  'color-mix(in srgb, var(--background) 90%, transparent) 10%,',
  'color-mix(in srgb, var(--background) 70%, transparent) 22%,',
  'color-mix(in srgb, var(--background) 40%, transparent) 40%,',
  'color-mix(in srgb, var(--background) 15%, transparent) 60%,',
  'transparent 80%)',
].join(' ')

const BOTTOM_GRADIENT = [
  'linear-gradient(to top,',
  'var(--background) 0%,',
  'color-mix(in srgb, var(--background) 85%, transparent) 15%,',
  'color-mix(in srgb, var(--background) 50%, transparent) 35%,',
  'color-mix(in srgb, var(--background) 20%, transparent) 55%,',
  'transparent 75%)',
].join(' ')

const GITHUB_URL = 'https://github.com/remorses/sigillo'
const X_URL = 'https://x.com/__morse'

export function HeroSection() {
  preload(HERO_FONT_URL, { as: 'style' })
  return (
    <>
    <link rel='stylesheet' href={HERO_FONT_URL} />
    <div className='relative mt-2 lg:mt-4 mb-4 lg:mb-6 w-screen ml-[calc(-50vw+50%)] flex flex-col items-center overflow-hidden'>
      {/* Three.js dotted video background */}
      <div
        className='absolute inset-0 w-full h-full z-0 overflow-hidden dark:opacity-60 opacity-40'
        style={{
          maskImage:
            'linear-gradient(to bottom, black 60%, transparent 100%)',
          WebkitMaskImage:
            'linear-gradient(to bottom, black 60%, transparent 100%)',
        }}
      >
        <DottedVideoBackground
          className='w-full h-full'
          config={{
            dotSize: 6,
            minDotSize: 1,
            dotMargin: 1,
            animSpeed: 3,
            gamma: 0.8,
            enableMask: false,
            fluidStrength: 0.2,
            fluidCurl: 80,
          }}
        />
      </div>

      {/* Top gradient overlay */}
      <div
        className='absolute top-0 inset-x-0 h-[60%] z-[1] pointer-events-none'
        style={{ background: TOP_GRADIENT }}
      />

      {/* Bottom gradient overlay */}
      <div
        className='absolute bottom-0 inset-x-0 h-[40%] z-[1] pointer-events-none'
        style={{ background: BOTTOM_GRADIENT }}
      />

      {/* Foreground content */}
      <div className='relative z-[2] flex flex-col items-center justify-center px-6 pt-10 sm:pt-14 pb-4'>
        <div className='flex flex-col items-center text-center'>
          <h1 className='flex flex-col items-center leading-none'>
            <span
              className='italic text-[28px] sm:text-[36px] md:text-[44px] font-medium text-foreground/80'
              style={{
                fontFamily:
                  "'Cormorant Garamond', Garamond, 'EB Garamond', 'Crimson Text', Georgia, serif",
              }}
            >
              secrets manager for
            </span>
            <span
              className='italic text-[28px] sm:text-[36px] md:text-[44px] font-medium text-foreground/80 -mt-1 sm:-mt-2'
              style={{
                fontFamily:
                  "'Cormorant Garamond', Garamond, 'EB Garamond', 'Crimson Text', Georgia, serif",
              }}
            >
              humans &amp; agents.
            </span>
          </h1>
          <p className='text-foreground/50 text-sm sm:text-base tracking-wide mt-3 sm:mt-4 max-w-2xl'>
            Replace <code className='text-xs bg-secondary px-1.5 py-0.5 rounded'>.env</code> files
            with a cloud-based secrets manager you can self-host.
            <br className='hidden sm:block' />
            Open-source alternative to Doppler and Infisical.
          </p>

          {/* Login with Google CTA */}
          <a
            href='/login'
            className='flex items-center gap-2 mt-7 sm:mt-8 px-4 py-2 bg-primary text-primary-foreground hover:opacity-90 transition-opacity rounded-md font-medium text-xs cursor-pointer no-underline'
          >
            <svg width={18} height={18} viewBox='0 0 24 24' fill='currentColor'>
              <path d='M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z' />
              <path d='M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z' />
              <path d='M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z' />
              <path d='M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z' />
            </svg>
            Login with Google
          </a>

          <div className='flex items-center gap-5 mt-4'>
            <a
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center gap-1.5 text-[13px] font-mono text-foreground/70 hover:text-foreground transition-colors no-underline'
              href={GITHUB_URL}
            >
              <GithubIcon size={14} />
              GitHub
            </a>
            <a
              target='_blank'
              rel='noopener noreferrer'
              className='flex items-center gap-1.5 text-[13px] font-mono text-foreground/70 hover:text-foreground transition-colors no-underline'
              href={X_URL}
            >
              <XIcon size={12} />
              @__morse
            </a>
          </div>
          <a
            href='#quick-start'
            className='mt-6 mb-2 flex flex-col items-center gap-1 text-[11px] font-mono text-foreground/30 hover:text-foreground/60 transition-colors no-underline'
          >
            Learn more
            <ArrowDown size={12} />
          </a>
        </div>
      </div>
    </div>
    </>
  )
}
