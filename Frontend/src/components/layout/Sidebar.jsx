import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  BarChart2,
  Upload,
  MapPin,
  Activity,
  Menu,
  X,
} from "lucide-react";
import { useState } from "react";

const links = [
  { to: "/",          label: "Dashboard",    icon: LayoutDashboard },
  { to: "/analysis",  label: "Análisis",     icon: BarChart2       },
  { to: "/upload",    label: "Cargar datos", icon: Upload          },
  { to: "/stations",  label: "Estaciones",   icon: MapPin          },
  { to: "/measurements", label: "Mediciones", icon: Activity       },
];

export default function Sidebar() {
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile toggle */}
      <button
        className="sidebar-mobile-toggle"
        onClick={() => setOpen(!open)}
        aria-label="Toggle sidebar"
      >
        {open ? <X size={20} /> : <Menu size={20} />}
      </button>

      <aside className={`sidebar ${open ? "sidebar--open" : ""}`}>
        <div className="sidebar__brand">
          <span className="sidebar__brand-icon">🌿</span>
          <span className="sidebar__brand-name">EcoSensor</span>
        </div>

        <nav className="sidebar__nav">
          {links.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                `sidebar__link ${isActive ? "sidebar__link--active" : ""}`
              }
              onClick={() => setOpen(false)}
            >
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar__footer">
          <span>API: {import.meta.env.VITE_API_URL || "localhost:8000"}</span>
        </div>
      </aside>

      {open && (
        <div className="sidebar-overlay" onClick={() => setOpen(false)} />
      )}
    </>
  );
}