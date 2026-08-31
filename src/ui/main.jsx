import { render } from 'preact'
import App from './App'
import { injectGlobalStyles, loadThemePref, applyThemePref } from './theme'
import './styles.css'

injectGlobalStyles()
applyThemePref(loadThemePref(), { persist: false })

// The shell hands the Android bottom system-bar height on the boot script, since
// env(safe-area-inset-bottom) is 0 in an Android WebView (it is real on iOS, so
// the stylesheet default still covers that side). Later changes - a rotation
// moving the bar - are injected by the shell directly.
const safeBottom = Number(window.__pearSafeBottom)
if (safeBottom > 0) document.documentElement.style.setProperty('--pear-safe-bottom', safeBottom + 'px')

render(<App />, document.getElementById('root'))
