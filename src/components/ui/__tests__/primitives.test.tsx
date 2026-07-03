import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Button } from '../button'
import { Badge } from '../badge'
import { Card } from '../card'

describe('Button', () => {
  it('renders its label', () => {
    const { getByRole } = render(<Button>Go</Button>)
    expect(getByRole('button').textContent).toBe('Go')
  })

  it('applies variant tokens', () => {
    const { getByRole } = render(<Button variant="primary">Go</Button>)
    expect(getByRole('button').className).toContain('bg-accent')
  })

  it('merges a custom className via cn/tailwind-merge', () => {
    const { getByRole } = render(<Button className="px-8">X</Button>)
    const cls = getByRole('button').className
    expect(cls).toContain('px-8')
    // tailwind-merge drops the conflicting base px-4 in favour of px-8
    expect(cls).not.toMatch(/\bpx-4\b/)
  })
})

describe('Badge', () => {
  it('applies the tone class', () => {
    const { getByText } = render(<Badge tone="warning">Heavy</Badge>)
    expect(getByText('Heavy').className).toContain('text-warning')
  })
})

describe('Card', () => {
  it('uses the glass surface when glass is set', () => {
    const { container } = render(<Card glass>hi</Card>)
    expect(container.firstElementChild?.className).toContain('glass')
  })
})
