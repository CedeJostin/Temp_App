import { BrowserRouter, Routes, Route } from "react-router-dom";
import Sidebar      from "./components/layout/Sidebar";
import Dashboard    from "./pages/Dashboard";
import Analysis     from "./pages/Analysis";
import Upload       from "./pages/Upload";
import Stations     from "./pages/Stations";
import Measurements from "./pages/Measurements";
import "./App.css";

export default function App() {
  return (
    <BrowserRouter>
      <div className="layout">
        <Sidebar />
        <main className="main">
          <Routes>
            <Route path="/"            element={<Dashboard />}    />
            <Route path="/analysis"    element={<Analysis />}     />
            <Route path="/upload"      element={<Upload />}       />
            <Route path="/stations"    element={<Stations />}     />
            <Route path="/measurements" element={<Measurements />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}