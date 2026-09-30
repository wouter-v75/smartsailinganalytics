'use client'
import * as React from 'react'
import { Sailboat, Wind, Moon, Sun } from 'lucide-react'
import {
  Button, Card, CardHeader, CardTitle, CardContent, Badge, Skeleton,
  EmptyState, ErrorState, Dialog, DialogTrigger, DialogContent, AutoTextarea,
} from '@/components/ui'

// A debrief section of the length that made the AI summary look cut short in a
// rows={5} box: the text was all there, five lines of it were visible.
const LONG = [
  'Starts — we were early to the pin twice and had to burn time, which put us',
  'behind the hundreds off the line in both races. The second start was better:',
  'we held the bow up and had a lane by the first cross.',
  'Upwind — the main was too flat for the pressure in race one. We went two turns',
  'on the backstay and the boat came alive.',
  'Mark roundings — the top mark in race two was slow; the kite was not ready.',
  'Downwind — good pace against Jethou, we gained twice on the gybes.',
].join(' ')

// Component gallery — the living reference for the SSA design system.
// Toggle light/dark to verify tokens flip and glass surfaces read in both.
export default function UiGallery() {
  const [theme, setTheme] = React.useState<'dark' | 'light'>('dark')
  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    return () => document.documentElement.setAttribute('data-theme', 'dark')
  }, [theme])

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section style={{ marginBottom: 28 }}>
      <h2 className="text-secondary" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>{title}</h2>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>{children}</div>
    </section>
  )

  return (
    <div className="bg-bg text-fg" style={{ minHeight: '100vh', padding: '28px 24px' }}>
      <div style={{ maxWidth: 880, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <h1 style={{ fontSize: 22, fontWeight: 500 }}>SSA design system</h1>
          <Badge tone="accent">Phase 0</Badge>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}>
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
            {theme === 'dark' ? 'Light' : 'Dark'} mode
          </Button>
        </div>

        <Section title="Buttons">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="glass">Glass</Button>
          <Button variant="primary" size="sm">Small</Button>
          <Button variant="secondary" size="lg">Large</Button>
          <Button variant="secondary" size="icon" aria-label="Wind"><Wind size={16} /></Button>
          <Button variant="primary" disabled>Disabled</Button>
        </Section>

        <Section title="Badges">
          <Badge>Neutral</Badge>
          <Badge tone="accent">Light</Badge>
          <Badge tone="success">On target</Badge>
          <Badge tone="warning">Heavy</Badge>
          <Badge tone="danger">Penalty</Badge>
        </Section>

        <Section title="Cards & glass">
          <Card style={{ width: 220 }}>
            <CardHeader><CardTitle>Solid card</CardTitle></CardHeader>
            <CardContent><p className="text-secondary" style={{ fontSize: 13 }}>bg-surface-1 with a hairline border.</p></CardContent>
          </Card>
          <div style={{ position: 'relative', width: 240, borderRadius: 12, overflow: 'hidden', padding: 2, background: 'linear-gradient(120deg,#06b6d4,#7f77dd,#d85a30)' }}>
            <Card glass style={{ position: 'relative' }}>
              <CardHeader><CardTitle>Glass card</CardTitle></CardHeader>
              <CardContent><p className="text-secondary" style={{ fontSize: 13 }}>Frosted surface over imagery / the timeline.</p></CardContent>
            </Card>
          </div>
        </Section>

        <Section title="Skeleton">
          <div style={{ width: 260 }}>
            <Skeleton style={{ height: 12, width: '60%', marginBottom: 8 }} />
            <Skeleton style={{ height: 12, width: '90%', marginBottom: 8 }} />
            <Skeleton style={{ height: 12, width: '75%' }} />
          </div>
        </Section>

        <Section title="AutoTextarea">
          {/* Side by side, because the point is only visible as a comparison:
              the fixed box stops mid-sentence and reads as truncated text. */}
          <div style={{ width: 340 }}>
            <div className="text-secondary" style={{ fontSize: 11, marginBottom: 4 }}>rows={5} — what it looked like</div>
            <textarea readOnly value={LONG} rows={5} data-testid="fixed-ta"
              style={{ width: '100%', fontSize: 13, fontFamily: 'inherit', padding: 8, borderRadius: 8 }} />
          </div>
          <div style={{ width: 340 }}>
            <div className="text-secondary" style={{ fontSize: 11, marginBottom: 4 }}>AutoTextarea — grows to its content</div>
            <AutoTextarea readOnly value={LONG} minRows={5} data-testid="auto-ta"
              style={{ width: '100%', fontSize: 13, fontFamily: 'inherit', padding: 8, borderRadius: 8 }} />
          </div>
        </Section>

        <Section title="Dialog (Radix + glass)">
          <Dialog>
            <DialogTrigger asChild><Button variant="primary">Open dialog</Button></DialogTrigger>
            <DialogContent title="Reconcile sail list" description="Two names differ from the inventory.">
              <p className="text-secondary" style={{ fontSize: 13 }}>Accessible focus-trap, escape-to-close, frosted panel.</p>
            </DialogContent>
          </Dialog>
        </Section>

        <Section title="States">
          <Card style={{ width: 300 }}><EmptyState icon={Sailboat} title="No scans yet" description="Import a SailScan PDF to see shapes here." action={{ label: 'Import scan', onClick: () => {} }} /></Card>
          <Card style={{ width: 300 }}><ErrorState description="Couldn't reach the forecast service." onRetry={() => {}} /></Card>
        </Section>
      </div>
    </div>
  )
}
