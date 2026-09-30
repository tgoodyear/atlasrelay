import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './lib/auth';
import { PageViews, startTelemetry } from './lib/telemetry';
// Fonts are served from this site (bundled by Vite), so no request goes to a font CDN.
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/inter/latin-800.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import './styles.css';

startTelemetry();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <PageViews />
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
