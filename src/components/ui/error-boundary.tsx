'use client'
import * as React from 'react'
import { ErrorState } from './states'

// Per-tab error boundary: a thrown render error shows an ErrorState (with retry)
// instead of white-screening the whole app. Wrap each tab / heavy panel:
//   <ErrorBoundary label="Weather"><WeatherTab/></ErrorBoundary>
interface Props {
  children: React.ReactNode
  label?: string
  fallback?: React.ReactNode
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error) {
    if (typeof console !== 'undefined') console.error('[ErrorBoundary]', this.props.label || '', error)
  }

  reset = () => this.setState({ error: null })

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback
      return (
        <ErrorState
          title={this.props.label ? `${this.props.label} didn't load` : "Something didn't load"}
          description="This section hit an error. The rest of the app is unaffected."
          onRetry={this.reset}
        />
      )
    }
    return this.props.children
  }
}
