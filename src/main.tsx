import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./lib/auth";
import { BetSlipProvider } from "./components/BetSlip";
import App from "./App";
import "./index.css";

const basename = (import.meta.env.BASE_URL || "/").replace(/\/$/, "") || "/";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename={basename === "/" ? undefined : basename}>
      <AuthProvider>
        <BetSlipProvider>
          <App />
        </BetSlipProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
