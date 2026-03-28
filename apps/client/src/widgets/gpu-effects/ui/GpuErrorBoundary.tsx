import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { hasError: boolean }

export class GpuErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error) {
    console.warn('[GPU Effects] Disabled due to error:', error.message)
  }

  render() {
    if (this.state.hasError) return null
    return this.props.children
  }
}
