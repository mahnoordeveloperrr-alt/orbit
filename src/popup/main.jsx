import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/common/ErrorBoundary';
import '../index.css';

// 🛡️ Root error boundary — a crash in any component renders a static
// emergency screen that still offers crash recovery (see ErrorBoundary.jsx).
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary emergency label="popup">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);