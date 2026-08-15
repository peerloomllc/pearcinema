import { render } from 'preact'
import App from './App'
import { injectGlobalStyles, loadThemePref, applyThemePref } from './theme'
import './styles.css'

injectGlobalStyles()
applyThemePref(loadThemePref(), { persist: false })

render(<App />, document.getElementById('root'))
