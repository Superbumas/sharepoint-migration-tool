import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const navItem = ({ isActive }) =>
  `shrink-0 px-3 py-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
    isActive ? 'bg-slate-900 text-white shadow-sm dark:bg-slate-100 dark:text-slate-900' : 'text-slate-600 hover:bg-slate-200/70'
  }`;

function NavLinks() {
  return (
    <>
      <NavLink to="/" end className={navItem}>Dashboard</NavLink>
      <NavLink to="/jobs" className={navItem}>Jobs</NavLink>
      <NavLink to="/mappings" className={navItem}>Mappings</NavLink>
      <NavLink to="/settings" className={navItem}>Settings</NavLink>
      <NavLink to="/projects" className={navItem}>Projects</NavLink>
    </>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
  }
  return (
    <button
      type="button"
      onClick={toggle}
      title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="w-8 h-8 shrink-0 rounded-md text-base flex items-center justify-center text-slate-500 hover:bg-slate-200/70 transition-colors"
    >
      <span aria-hidden>{dark ? '☀️' : '🌙'}</span>
    </button>
  );
}

// One place to fix sign-in trouble instead of a cryptic error inside each
// picker: shown when a Microsoft call for this project needs a fresh sign-in,
// or when the project was never connected (its engine app isn't set up yet).
function AuthBanner({ user }) {
  const [reauth, setReauth] = useState(false);
  useEffect(() => {
    const on = () => setReauth(true);
    window.addEventListener('auth:reauth-required', on);
    return () => window.removeEventListener('auth:reauth-required', on);
  }, []);
  if (!user?.project) return null;
  const notConnected = user.project.engine?.mode === 'not_provisioned';
  if (!reauth && !notConnected) return null;
  const href = `/auth/login?project=${encodeURIComponent(user.project.id)}${user.upn ? `&hint=${encodeURIComponent(user.upn)}` : ''}`;
  return (
    <div role="status" className="border-t border-amber-200 bg-amber-50 text-amber-800 text-sm">
      <div className="max-w-7xl mx-auto px-4 py-2 flex flex-wrap items-center justify-between gap-2">
        <span>
          {reauth
            ? 'Your Microsoft sign-in for this project has expired, so sites and files can\'t be loaded.'
            : 'This project isn\'t connected to its tenant yet. A Global Admin of that tenant needs to finish connecting it once.'}
        </span>
        <a href={href} className="font-medium underline whitespace-nowrap">{reauth ? 'Reconnect' : 'Connect project'}</a>
      </div>
    </div>
  );
}

export default function Header() {
  const { user } = useAuth();

  return (
    <header className="bg-white/90 backdrop-blur border-b border-slate-200 sticky top-0 z-10">
      {/* One row from lg up. Below lg the nav drops to its own horizontally
          scrollable row, so the page never scrolls sideways. The signed-in
          name and email live in the avatar's tooltip - there's no room for
          them next to the nav and the project chip without wrapping. */}
      <div className="max-w-7xl mx-auto px-4 flex flex-wrap lg:flex-nowrap items-center justify-between gap-x-4">
        <div className="flex items-center gap-5 min-w-0 h-16">
          <div className="flex items-center gap-2.5 shrink-0">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-sm font-bold shadow-sm" aria-hidden>
              ⇥
            </div>
            <span className="font-semibold text-slate-800 whitespace-nowrap">
              <span className="hidden sm:inline">SharePoint Migration Tool</span>
              <span className="sm:hidden">Migration Tool</span>
            </span>
          </div>
          {user?.project && (
            <span className="hidden xl:inline-flex items-center gap-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-full px-2.5 py-1 whitespace-nowrap max-w-xs" title={`Signed into project "${user.project.name}"${user.project.tenantName ? ` (tenant ${user.project.tenantName})` : ''}`}>
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
              </span>
              {user.project.name}
              {/* Suffix only when it adds information - a project named after
                  its tenant would otherwise read "x.onmicrosoft.com · x.onmicrosoft.com" */}
              {user.project.tenantName && user.project.tenantName.toLowerCase() !== user.project.name?.toLowerCase() && (
                <span className="text-indigo-400 font-normal truncate">· {user.project.tenantName}</span>
              )}
            </span>
          )}
          <nav aria-label="Main" className="hidden lg:flex gap-1">
            <NavLinks />
          </nav>
        </div>

        {user ? (
          <div className="flex items-center gap-3 shrink-0 h-16">
            <ThemeToggle />
            {user.role === 'admin' && (
              <span className="hidden sm:inline text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-px" title="Admin - sees every user's mappings and jobs">
                Admin
              </span>
            )}
            {user.photoDataUrl ? (
              <img src={user.photoDataUrl} alt={user.displayName} width={36} height={36} title={`${user.displayName} · ${user.email}`} className="w-9 h-9 shrink-0 rounded-full object-cover ring-2 ring-slate-100" />
            ) : (
              <div title={`${user.displayName} · ${user.email}`} className="w-9 h-9 shrink-0 rounded-full bg-gradient-to-br from-slate-300 to-slate-400 flex items-center justify-center text-sm font-semibold text-white">
                {(user.displayName || '?').slice(0, 1)}
              </div>
            )}
            <a href="/auth/logout" className="text-sm text-slate-500 hover:text-slate-800 whitespace-nowrap">Sign out</a>
          </div>
        ) : (
          <div className="flex items-center gap-3 shrink-0 h-16">
            <ThemeToggle />
            <a href="/auth/login" className="text-sm font-medium text-blue-600 hover:text-blue-800 whitespace-nowrap">Sign in</a>
          </div>
        )}

        <nav aria-label="Main" className="lg:hidden w-full flex gap-1 overflow-x-auto pb-2 -mx-1 px-1">
          <NavLinks />
        </nav>
      </div>
      <AuthBanner user={user} />
    </header>
  );
}
