import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import Component from '/Users/justinsato/poker-gto-hud/resources/poker-hud/widget.tsx'

const container = document.getElementById('widget-root')
if (container && Component) {
  const root = createRoot(container)
  root.render(<Component />)
  
  // Signal to parent that widget has mounted (after a brief delay for initial render)
  setTimeout(() => {
    window.parent.postMessage({ type: 'mcp-inspector:widget:ready' }, '*')
  }, 100)
}
