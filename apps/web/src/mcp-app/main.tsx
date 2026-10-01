import { createRoot } from "react-dom/client";
import Root from "./App";
import "./app.css";

// No StrictMode: its double mount would connect to the host twice.
createRoot(document.getElementById("root")!).render(<Root />);
