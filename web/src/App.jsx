import React from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Header from './components/Header';
import ProjectPicker from './components/ProjectPicker';
import SignIn from './components/SignIn';
import Dashboard from './components/Dashboard';
import JobQueue from './components/JobQueue';
import JobDetail from './components/JobDetail';
import MappingsPage from './components/MappingsPage';
import Settings from './components/Settings';
import ErrorBoundary from './components/ErrorBoundary';

function Gate({ children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="max-w-7xl mx-auto p-8 text-slate-500">Loading…</div>;
  }
  if (!user) {
    // One button, no decisions: the server lands the account in its own
    // tenant's project (creating it on first sign-in). /projects remains
    // the explicit multi-tenant switcher.
    return <SignIn />;
  }
  return children;
}

export default function App() {
  const location = useLocation();
  return (
    <AuthProvider>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-20 focus:bg-white focus:px-3 focus:py-2 focus:rounded-md focus:shadow">Skip to content</a>
      <Header />
      <main id="main" className="max-w-7xl mx-auto px-4 py-6">
        <ErrorBoundary key={location.pathname}>
        <Routes>
          {/* Always reachable, signed in or not - the only way to switch to
              or create a different project once you're already signed into
              one (switching means signing into a different project, see
              ProjectPicker.jsx). Everything else requires being signed in. */}
          <Route path="/projects" element={<ProjectPicker />} />
          <Route
            path="/*"
            element={
              <Gate>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/jobs" element={<JobQueue />} />
                  <Route path="/jobs/:id" element={<JobDetail />} />
                  <Route path="/mappings" element={<MappingsPage />} />
                  <Route path="/settings" element={<Settings />} />
                </Routes>
              </Gate>
            }
          />
        </Routes>
        </ErrorBoundary>
      </main>
    </AuthProvider>
  );
}
