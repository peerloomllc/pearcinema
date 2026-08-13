import { render } from 'preact'
import App from './App'
import { loadThemePref, resolveTheme } from './ui'
import './styles.css'

// Theme before the first paint so there is no flash of the wrong one. The generated
// document also carries a dark background in its <head> for the same reason.
document.documentElement.setAttribute('data-theme', resolveTheme(loadThemePref()))

render(<App />, document.getElementById('root'))
