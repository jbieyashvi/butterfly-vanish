import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// No StrictMode: its double-mount would open and close the camera twice.
createRoot(document.getElementById('root')!).render(<App />)
