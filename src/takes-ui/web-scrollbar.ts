// A quieter scrollbar on the web: thin, a translucent grey thumb, no track. The browser's
// default drew a light track beside the dark feed. Grey at partial opacity reads on both the
// light and dark palettes. One stylesheet, added once at startup; the phone draws its own.
//
// Firefox and Chrome 121+ use scrollbar-width/scrollbar-color (and then ignore the -webkit
// rules); Safari uses the -webkit pseudo-elements.

import { Platform } from 'react-native'

const CSS = `
* { scrollbar-width: thin; scrollbar-color: rgba(128, 128, 128, 0.35) transparent; }
*::-webkit-scrollbar { width: 6px; height: 6px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.35); border-radius: 3px; }
*::-webkit-scrollbar-thumb:hover { background: rgba(128, 128, 128, 0.6); }
`

if (Platform.OS === 'web' && typeof document !== 'undefined' && !document.getElementById('takes-scrollbar')) {
  const style = document.createElement('style')
  style.id = 'takes-scrollbar'
  style.textContent = CSS
  document.head.appendChild(style)
}
