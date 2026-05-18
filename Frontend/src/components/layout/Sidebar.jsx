import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Upload,
  BarChart2,
  CloudRain,
  Sun,
  Moon
} from 'lucide-react'

const navItems = [
  { to: '/',        icon: LayoutDashboard, label: 'Dashboard'  },
  { to: '/upload',  icon: Upload,          label: 'Cargar datos' },
  { to: '/analysis',icon: BarChart2,       label: 'Análisis'   },
]

export default function Sidebar({ darkMode, toggleDark }) {
  return (
    <aside className="flex flex-col w-60 min-h-screen border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-6 shrink-0">

      {/* Logo */}
      <div className="flex items-center gap-2 mb-10 px-2">
        <CloudRain className="text-blue-500" size={22} />
        <span className="font-semibold text-gray-800 dark:text-gray-100 tracking-tight">
          MeteoUNED
        </span>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-1 flex-1">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors
              ${isActive
                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 font-medium'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`
            }
          >
            <Icon size={18} />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* Toggle dark mode */}
      <button
        onClick={toggleDark}
        className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors mt-4"
      >
        {darkMode ? <Sun size={18} /> : <Moon size={18} />}
        {darkMode ? 'Modo claro' : 'Modo oscuro'}
      </button>
    </aside>
  )
}