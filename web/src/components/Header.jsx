import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import Logo from './Logo';

// Layout follows the Knowall CRM: a slim top bar with the logo in the middle,
// and a dark sidebar on the left whose active item is Knowall orange.

const ICONS = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>,
  jobs: <><path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" /></>,
  mappings: <><path d="M4 7h13M13 3l4 4-4 4" /><path d="M20 17H7M11 13l-4 4 4 4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
  projects: <><path d="M3 21h18" /><path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16" /><path d="M15 9h2a2 2 0 0 1 2 2v10" /><path d="M9 7h2M9 11h2M9 15h2" /></>,
  signout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5M21 12H9" /></>,
  menu: <path d="M3 6h18M3 12h18M3 18h18" />,
};

function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
      {ICONS[name]}
    </svg>
  );
}

const navItem = ({ isActive }) =>
  `flex items-center gap-3 px-4 py-2.5 text-sm font-medium transition-colors ${
    isActive ? 'bg-brand-500 text-white' : 'text-sidebar-text hover:bg-sidebar-hover hover:text-white'
  }`;

const NAV = [
  { to: '/', end: true, icon: 'dashboard', label: 'Dashboard' },
  { to: '/jobs', icon: 'jobs', label: 'Jobs' },
  { to: '/mappings', icon: 'mappings', label: 'Mappings' },
  { to: '/settings', icon: 'settings', label: 'Settings' },
  { to: '/projects', icon: 'projects', label: 'Clients' },
];

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
export function AuthBanner() {
  const { user } = useAuth();
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
    <div role="status" className="border-b border-amber-200 bg-amber-50 text-amber-800 text-sm">
      <div className="px-6 py-2 flex flex-wrap items-center justify-between gap-2">
        <span>
          {reauth
            ? 'Your Microsoft sign-in for this client has expired, so sites and files can\'t be loaded.'
            : 'This client isn\'t connected to its tenant yet. A Global Admin of that tenant needs to finish connecting it once.'}
        </span>
        <a href={href} className="font-medium underline whitespace-nowrap">{reauth ? 'Reconnect' : 'Connect client'}</a>
      </div>
    </div>
  );
}

// Left navigation. Dark on both themes, like the CRM. The signed-in project
// sits at the top and the account at the bottom.
export function Sidebar() {
  const { user } = useAuth();
  if (!user) return null;
  const project = user.project;
  return (
    <aside id="sidebar" className="sidebar w-56 shrink-0 bg-sidebar text-sidebar-text flex flex-col sticky top-14 h-[calc(100vh-3.5rem)] overflow-y-auto">
      {project && (
        <div className="px-4 py-3 border-b border-sidebar-line" title={`Signed into client "${project.name}"${project.tenantName ? ` (tenant ${project.tenantName})` : ''}`}>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-sidebar-text/80 mb-1">Client</div>
          <div className="flex items-center gap-2 text-sm font-medium text-white min-w-0">
            <span className="relative flex h-1.5 w-1.5 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
            </span>
            <span className="truncate">{project.name}</span>
          </div>
          {/* Second line only when it adds information - a project named
              after its tenant would otherwise repeat itself. */}
          {project.tenantName && project.tenantName.toLowerCase() !== project.name?.toLowerCase() && (
            <div className="text-xs text-sidebar-text/70 truncate pl-3.5">{project.tenantName}</div>
          )}
        </div>
      )}
      <nav aria-label="Main" className="py-2 flex-1">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className={navItem}>
            <Icon name={n.icon} />
            {n.label}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-sidebar-line py-2">
        <div className="px-4 py-2 min-w-0">
          <div className="text-sm font-medium text-white truncate">{user.displayName}</div>
          <div className="text-xs text-sidebar-text/70 truncate">{user.email}</div>
        </div>
        <a href="/auth/logout" className="flex items-center gap-3 px-4 py-2.5 text-sm font-medium text-sidebar-text hover:bg-sidebar-hover hover:text-white transition-colors">
          <Icon name="signout" />
          Sign out
        </a>
      </div>
    </aside>
  );
}

export default function Header({ onToggleSidebar, sidebarOpen }) {
  const { user } = useAuth();

  return (
    <header className="bg-white border-b border-slate-200 sticky top-0 z-10 h-14 grid grid-cols-3 items-center px-4">
      <div className="flex items-center gap-3 min-w-0">
        {user && (
          <button
            type="button"
            onClick={onToggleSidebar}
            title={sidebarOpen ? 'Hide the menu' : 'Show the menu'}
            aria-label={sidebarOpen ? 'Hide the menu' : 'Show the menu'}
            aria-expanded={sidebarOpen}
            aria-controls="sidebar"
            className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center text-slate-700 hover:bg-slate-200/70 transition-colors"
          >
            <Icon name="menu" size={20} />
          </button>
        )}
        <span className="font-semibold text-slate-800 whitespace-nowrap truncate">SharePoint Migration Tool</span>
      </div>

      <Logo height={28} className="justify-self-center" />

      {user ? (
        <div className="flex items-center justify-end gap-3">
          <ThemeToggle />
          {user.role === 'admin' && (
            <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 rounded px-1 py-px" title="Admin - sees every user's mappings and jobs">
              Admin
            </span>
          )}
          {user.photoDataUrl ? (
            <img src={user.photoDataUrl} alt={user.displayName} width={32} height={32} title={`${user.displayName} · ${user.email}`} className="w-8 h-8 shrink-0 rounded-full object-cover ring-2 ring-slate-100" />
          ) : (
            <div title={`${user.displayName} · ${user.email}`} className="w-8 h-8 shrink-0 rounded-full bg-gradient-to-br from-slate-300 to-slate-400 flex items-center justify-center text-sm font-semibold text-white">
              {(user.displayName || '?').slice(0, 1)}
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-end gap-3">
          <ThemeToggle />
          <a href="/auth/login" className="text-sm font-medium text-blue-600 hover:text-blue-800 whitespace-nowrap">Sign in</a>
        </div>
      )}
    </header>
  );
}
