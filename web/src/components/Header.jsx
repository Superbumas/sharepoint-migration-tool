import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const navItem = ({ isActive }) =>
  `px-3 py-2 rounded-md text-sm font-medium transition-colors ${
    isActive ? 'bg-slate-900 text-white shadow-sm dark:bg-slate-100 dark:text-slate-900' : 'text-slate-600 hover:bg-slate-200/70'
  }`;

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
      onClick={toggle}
      title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="w-8 h-8 rounded-md text-base flex items-center justify-center text-slate-500 hover:bg-slate-200/70 transition-colors"
    >
      {dark ? '☀️' : '🌙'}
    </button>
  );
}

export default function Header() {
  const { user } = useAuth();

  return (
    <header className="bg-white/90 backdrop-blur border-b border-slate-200 sticky top-0 z-10">
      <div className="max-w-7xl mx-auto px-4 flex items-center justify-between h-16">
        <div className="flex items-center gap-5">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-sm font-bold shadow-sm" aria-hidden>
              ⇥
            </div>
            <span className="font-semibold text-slate-800">SharePoint Migration Tool</span>
          </div>
          {user?.project && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-full px-2.5 py-1" title={`Signed into project "${user.project.name}"${user.project.tenantName ? ` (tenant ${user.project.tenantName})` : ''}`}>
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
              </span>
              {user.project.name}
              {/* Suffix only when it adds information - a project named after
                  its tenant would otherwise read "x.onmicrosoft.com · x.onmicrosoft.com" */}
              {user.project.tenantName && user.project.tenantName.toLowerCase() !== user.project.name?.toLowerCase() && (
                <span className="text-indigo-400 font-normal">· {user.project.tenantName}</span>
              )}
            </span>
          )}
          <nav className="flex gap-1">
            <NavLink to="/" end className={navItem}>Dashboard</NavLink>
            <NavLink to="/jobs" className={navItem}>Jobs</NavLink>
            <NavLink to="/mappings" className={navItem}>Mappings</NavLink>
            <NavLink to="/settings" className={navItem}>Settings</NavLink>
            <NavLink to="/projects" className={navItem}>Projects</NavLink>
          </nav>
        </div>

        {user ? (
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <div className="text-right leading-tight">
              <div className="text-sm font-medium text-slate-800 flex items-center justify-end gap-1.5">
                {user.displayName}
                {user.role === 'admin' && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-px" title="Admin - sees every user's mappings and jobs">
                    Admin
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-500">{user.email}</div>
            </div>
            {user.photoDataUrl ? (
              <img src={user.photoDataUrl} alt={user.displayName} className="w-9 h-9 rounded-full object-cover ring-2 ring-slate-100" />
            ) : (
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-slate-300 to-slate-400 flex items-center justify-center text-sm font-semibold text-white">
                {(user.displayName || '?').slice(0, 1)}
              </div>
            )}
            <a href="/auth/logout" className="text-sm text-slate-500 hover:text-slate-800">Sign out</a>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <a href="/auth/login" className="text-sm font-medium text-blue-600 hover:text-blue-800">Sign in</a>
          </div>
        )}
      </div>
    </header>
  );
}
