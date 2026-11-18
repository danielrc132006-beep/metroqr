// Configuración de la API de Google Apps Script (backend en Google Sheets).
// La clave de acceso NO va aquí: el repositorio es público. Se escribe una vez en cada equipo
// (iPad o computadora) y queda guardada solo en ese navegador.
window.CONFIG = {
  API_URL: "https://script.google.com/macros/s/AKfycbyKUK-NcGYJI-qfR4MJjKadFhgeY4eM3XL7HgCX0pt2bf4mIOVMq-8lWmau0deo9gnKxQ/exec"
};

(function () {
  const LLAVE = "managerlab.clave";
  let cancelada = false;   // si se cancela el aviso, no se vuelve a pedir hasta recargar la página
  window.claveApi = function () {
    let c = "";
    try { c = localStorage.getItem(LLAVE) || ""; } catch (e) { /* sin almacenamiento */ }
    if (!c && !cancelada) {
      c = (window.prompt("Clave de acceso de ManagerLAB (pídala al responsable del sistema):") || "").trim();
      if (!c) cancelada = true;
      try { if (c) localStorage.setItem(LLAVE, c); } catch (e) { /* sin almacenamiento */ }
    }
    return c;
  };
  // Si la API la rechaza, se borra para pedirla otra vez
  window.olvidarClave = function () {
    cancelada = false;
    try { localStorage.removeItem(LLAVE); } catch (e) { /* sin almacenamiento */ }
  };
})();
