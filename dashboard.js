/* =========================================================
   Dashboard de ManagerLAB
   Lee los préstamos y el catálogo desde la API (config.js)
   y dibuja indicadores, gráficas y la tabla del periodo.
   ========================================================= */

const $ = (id) => document.getElementById(id);

const tablero = {
  prestamos: [],     // todos los préstamos de la hoja
  catalogo: [],      // para mostrar también los instrumentos nunca prestados
  dias: 7,           // periodo elegido: 1 = hoy, 7, 30, 0 = todo
  verTodos: false
};
const FILAS_INICIALES = 15;
const NOMBRES_DIA = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];

/* ---------------------------------------------------------
   1. Datos
   --------------------------------------------------------- */

async function consultarApi(accion) {
  const url = `${CONFIG.API_URL}?accion=${accion}&clave=${encodeURIComponent(CONFIG.API_CLAVE)}`;
  const respuesta = await fetch(url, { redirect: "follow" });
  const datos = await respuesta.json();
  if (!datos.ok) throw new Error(datos.error || "La API devolvió un error.");
  return datos.datos;
}

function marcarConexion(conectado) {
  $("conexion").classList.toggle("ok", conectado);
  $("conexion").classList.toggle("error", !conectado);
  $("conexion").querySelector(".conexion-texto").textContent = conectado ? "Conectado" : "Sin conexión";
}

// Fecha local en formato AAAA-MM-DD
function fechaISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// La hoja puede devolver la fecha como texto "2026-10-26" o como fecha completa; se normaliza
function normalizarPrestamo(p) {
  let fecha = String(p.fecha || "");
  if (fecha.includes("T")) fecha = fechaISO(new Date(fecha));
  let hora = String(p.hora || "");
  if (hora.includes("T")) { const h = new Date(hora); hora = `${String(h.getHours()).padStart(2, "0")}:${String(h.getMinutes()).padStart(2, "0")}`; }
  return { ...p, fecha: fecha.slice(0, 10), hora: hora.slice(0, 5), matricula: String(p.matricula), cantidad: Number(p.cantidad) || 0 };
}

async function cargarDatos() {
  $("btnActualizar").classList.add("girando");
  try {
    const [prestamos, catalogo] = await Promise.all([consultarApi("prestamos"), consultarApi("catalogo")]);
    tablero.prestamos = prestamos.map(normalizarPrestamo);
    tablero.catalogo = catalogo;
    marcarConexion(true);
    $("errorCarga").hidden = true;
    $("actualizado").textContent = `Actualizado a las ${new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })} · se actualiza cada minuto`;
    pintarTodo();
  } catch (error) {
    marcarConexion(false);
    $("errorCarga").textContent = "No se pudieron cargar los datos. Revise la conexión y toque Actualizar.";
    $("errorCarga").hidden = false;
  } finally {
    $("btnActualizar").classList.remove("girando");
  }
}

// Préstamos que caen dentro del periodo elegido
function prestamosDelPeriodo() {
  if (!tablero.dias) return tablero.prestamos;
  const inicio = new Date();
  inicio.setDate(inicio.getDate() - (tablero.dias - 1));
  const desde = fechaISO(inicio);
  return tablero.prestamos.filter((p) => p.fecha >= desde);
}

// Agrupa por un campo y suma piezas y número de préstamos: agrupar(lista, "area")
function agrupar(lista, campo) {
  const mapa = new Map();
  lista.forEach((p) => {
    const actual = mapa.get(p[campo]) || { piezas: 0, prestamos: 0 };
    actual.piezas += p.cantidad;
    actual.prestamos += 1;
    mapa.set(p[campo], actual);
  });
  return mapa;
}

/* ---------------------------------------------------------
   2. Dibujo
   --------------------------------------------------------- */

function pintarTodo() {
  const lista = prestamosDelPeriodo();
  pintarIndicadores(lista);
  pintarInstrumentos(lista);
  pintarActividad(lista);
  pintarAreas(lista);
  pintarTabla(lista);
  if (window.lucide) lucide.createIcons();
}

// Singular o plural según la cantidad: plural(1, "pieza", "piezas") → "1 pieza"
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

const textoPeriodo = () => ({ 1: "hoy", 7: "en los últimos 7 días", 30: "en los últimos 30 días", 0: "en total" })[tablero.dias];

function pintarIndicadores(lista) {
  const piezas = lista.reduce((s, p) => s + p.cantidad, 0);
  const trabajadores = new Set(lista.map((p) => p.matricula)).size;
  const porInstrumento = [...agrupar(lista, "instrumento").entries()].sort((a, b) => b[1].piezas - a[1].piezas);

  $("kPrestamos").textContent = lista.length;
  $("kPrestamosSub").textContent = textoPeriodo();
  $("kPiezas").textContent = piezas;
  $("kPiezasSub").textContent = lista.length ? `${(piezas / lista.length).toFixed(1)} por préstamo` : "sin préstamos";
  $("kTrabajadores").textContent = trabajadores;
  $("kTrabajadoresSub").textContent = trabajadores === 1 ? "persona distinta" : "personas distintas";
  $("kTop").textContent = porInstrumento.length ? porInstrumento[0][0] : "Sin datos";
  $("kTopSub").textContent = porInstrumento.length ? `${plural(porInstrumento[0][1].piezas, "pieza", "piezas")} en ${plural(porInstrumento[0][1].prestamos, "préstamo", "préstamos")}` : "";
}

// Crea una fila de barra horizontal (nombre | barra | valor) con texto seguro
function crearFilaBarra({ nombre, detalle, valor, maximo, globo }) {
  const fila = document.createElement("div");
  fila.className = "barra-fila" + (valor ? "" : " cero");
  fila.setAttribute("role", "listitem");
  fila.tabIndex = 0;
  fila.innerHTML = `<span class="barra-nombre"></span><span class="barra-pista"><span class="barra-relleno"></span></span><span class="barra-valor"></span>`;
  const n = fila.querySelector(".barra-nombre");
  n.textContent = nombre;
  if (detalle) { const s = document.createElement("small"); s.textContent = detalle; n.appendChild(s); }
  fila.querySelector(".barra-relleno").style.width = maximo ? `${(valor / maximo) * 100}%` : "0";
  fila.querySelector(".barra-valor").innerHTML = `${valor}<small>pzs</small>`;
  fila.setAttribute("aria-label", globo.replace(/<[^>]+>/g, " "));
  activarGlobo(fila, globo);
  return fila;
}

// Instrumentos: todo el catálogo, ordenado de más a menos piezas
function pintarInstrumentos(lista) {
  const conteo = agrupar(lista, "instrumento");
  const filas = tablero.catalogo.map((c) => ({ ...c, ...(conteo.get(c.instrumento) || { piezas: 0, prestamos: 0 }) }));
  // Instrumentos que están en préstamos pero ya no en el catálogo
  conteo.forEach((v, nombre) => { if (!filas.some((f) => f.instrumento === nombre)) filas.push({ instrumento: nombre, clave: "", ...v }); });
  filas.sort((a, b) => b.piezas - a.piezas || a.instrumento.localeCompare(b.instrumento));

  const maximo = Math.max(...filas.map((f) => f.piezas), 0);
  const caja = $("graficaInstrumentos");
  caja.innerHTML = "";
  if (!filas.length) { caja.innerHTML = '<p class="vacio">Sin instrumentos en el catálogo.</p>'; return; }
  filas.forEach((f) => caja.appendChild(crearFilaBarra({
    nombre: f.instrumento, detalle: f.clave, valor: f.piezas, maximo,
    globo: `<strong>${escapar(f.instrumento)}</strong>${plural(f.piezas, "pieza", "piezas")} · ${plural(f.prestamos, "préstamo", "préstamos")}`
  })));
}

function pintarAreas(lista) {
  const filas = [...agrupar(lista, "area").entries()].sort((a, b) => b[1].piezas - a[1].piezas);
  const maximo = Math.max(...filas.map(([, v]) => v.piezas), 0);
  const caja = $("graficaAreas");
  caja.innerHTML = "";
  if (!filas.length) { caja.innerHTML = '<p class="vacio">Sin préstamos en este periodo.</p>'; return; }
  filas.forEach(([area, v]) => caja.appendChild(crearFilaBarra({
    nombre: area, valor: v.piezas, maximo,
    globo: `<strong>${escapar(area)}</strong>${plural(v.piezas, "pieza", "piezas")} · ${plural(v.prestamos, "préstamo", "préstamos")}`
  })));
}

// Actividad: por hora si el periodo es "hoy"; si no, por día (máximo 30 columnas)
function pintarActividad(lista) {
  let cubetas;
  if (tablero.dias === 1) {
    $("tituloActividad").textContent = "Préstamos por hora";
    $("notaActividad").textContent = "Turno de hoy, de 6:00 a 21:00";
    cubetas = Array.from({ length: 16 }, (_, i) => ({ clave: String(i + 6).padStart(2, "0"), etiqueta: `${i + 6}`, nombre: `${i + 6}:00 a ${i + 6}:59` }));
    cubetas.forEach((c) => (c.valor = lista.filter((p) => p.hora.slice(0, 2) === c.clave).length));
  } else {
    const n = tablero.dias || Math.min(30, Math.max(7, diasDesdePrimerPrestamo()));
    $("tituloActividad").textContent = "Préstamos por día";
    $("notaActividad").textContent = `Últimos ${n} días`;
    cubetas = Array.from({ length: n }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - (n - 1 - i));
      return { clave: fechaISO(d), etiqueta: n <= 7 ? NOMBRES_DIA[d.getDay()] : String(d.getDate()), nombre: d.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" }) };
    });
    const todos = tablero.dias ? lista : tablero.prestamos;
    cubetas.forEach((c) => (c.valor = todos.filter((p) => p.fecha === c.clave).length));
  }

  const maximo = Math.max(...cubetas.map((c) => c.valor), 1);
  const caja = $("graficaActividad");
  caja.innerHTML = "";
  cubetas.forEach((c) => {
    const col = document.createElement("div");
    col.className = "columna" + (c.valor ? "" : " cero");
    col.setAttribute("role", "listitem");
    col.tabIndex = 0;
    col.setAttribute("aria-label", `${c.nombre}: ${c.valor} préstamos`);
    // Solo se rotula el valor de las columnas con datos (no un número en cada punto)
    col.innerHTML = `${c.valor ? `<span class="columna-valor">${c.valor}</span>` : ""}<span class="columna-relleno"></span>`;
    col.querySelector(".columna-relleno").style.height = `${(c.valor / maximo) * 82}%`;
    activarGlobo(col, `<strong>${escapar(c.nombre)}</strong>${c.valor} ${c.valor === 1 ? "préstamo" : "préstamos"}`);
    caja.appendChild(col);
  });
  // Eje inferior: si hay muchas columnas se rotula una de cada tres
  let eje = caja.nextElementSibling;
  if (!eje || !eje.classList.contains("columnas-ejes")) { eje = document.createElement("div"); eje.className = "columnas-ejes"; caja.after(eje); }
  eje.innerHTML = cubetas.map((c, i) => `<span>${cubetas.length > 16 && i % 3 ? "" : escapar(c.etiqueta)}</span>`).join("");
  eje.setAttribute("aria-hidden", "true");
}

function diasDesdePrimerPrestamo() {
  if (!tablero.prestamos.length) return 7;
  const primera = tablero.prestamos.reduce((m, p) => (p.fecha < m ? p.fecha : m), "9999");
  return Math.ceil((Date.now() - new Date(primera + "T00:00:00")) / 86400000) + 1;
}

function pintarTabla(lista) {
  const texto = $("buscar").value.trim().toLowerCase();
  const filas = lista
    .filter((p) => !texto || [p.nombre, p.matricula, p.folio, p.instrumento].some((v) => String(v).toLowerCase().includes(texto)))
    .sort((a, b) => (b.fecha + b.hora + b.folio).localeCompare(a.fecha + a.hora + a.folio));
  const visibles = tablero.verTodos ? filas : filas.slice(0, FILAS_INICIALES);

  $("notaTabla").textContent = `${filas.length} ${filas.length === 1 ? "préstamo" : "préstamos"} ${textoPeriodo()}${texto ? " que coinciden con la búsqueda" : ""}`;
  $("filas").innerHTML = visibles.length
    ? visibles.map((p) => `<tr>
        <td class="folio">${escapar(p.folio)}</td><td>${escapar(p.fecha)}</td><td>${escapar(p.hora)}</td>
        <td>${escapar(p.nombre)}<span class="sub">${escapar(p.matricula)}</span></td>
        <td>${escapar(p.area)}</td><td>${escapar(p.instrumento)}</td><td class="num-col">${p.cantidad}</td></tr>`).join("")
    : `<tr class="vacio-fila"><td colspan="7">${texto ? "Ningún préstamo coincide con la búsqueda." : "No hay préstamos en este periodo. Pruebe con “Todo”."}</td></tr>`;
  $("btnVerMas").hidden = filas.length <= FILAS_INICIALES;
  $("btnVerMas").textContent = tablero.verTodos ? "Ver menos" : `Ver los ${filas.length}`;
}

/* ---------------------------------------------------------
   3. Interacción
   --------------------------------------------------------- */

// Globo de información: aparece al pasar el mouse, al tocar o al enfocar con teclado
function activarGlobo(elemento, html) {
  const mostrar = () => {
    const g = $("globo");
    g.innerHTML = html;
    g.hidden = false;
    const r = elemento.getBoundingClientRect();
    const x = Math.min(window.innerWidth - g.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - g.offsetWidth / 2));
    const y = r.top - g.offsetHeight - 8 < 8 ? r.bottom + 8 : r.top - g.offsetHeight - 8;
    g.style.left = `${x}px`; g.style.top = `${y}px`;
  };
  const ocultar = () => ($("globo").hidden = true);
  elemento.addEventListener("pointerenter", mostrar);
  elemento.addEventListener("pointerleave", ocultar);
  elemento.addEventListener("focus", mostrar);
  elemento.addEventListener("blur", ocultar);
}
window.addEventListener("scroll", () => ($("globo").hidden = true), { passive: true });

document.querySelectorAll(".periodo button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".periodo button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
  tablero.dias = Number(b.dataset.dias);
  tablero.verTodos = false;
  pintarTodo();
}));
$("btnActualizar").addEventListener("click", cargarDatos);
$("buscar").addEventListener("input", () => pintarTabla(prestamosDelPeriodo()));
$("btnVerMas").addEventListener("click", () => { tablero.verTodos = !tablero.verTodos; pintarTabla(prestamosDelPeriodo()); });

// Exporta los préstamos del periodo a CSV (Excel lo abre con acentos gracias al BOM)
$("btnExportar").addEventListener("click", () => {
  const columnas = ["folio", "fecha", "hora", "matricula", "nombre", "area", "jefe", "instrumento", "cantidad"];
  const lineas = prestamosDelPeriodo().map((p) => columnas.map((c) => `"${String(p[c] ?? "").replace(/"/g, '""')}"`).join(","));
  const enlace = document.createElement("a");
  enlace.href = URL.createObjectURL(new Blob(["﻿" + [columnas.join(","), ...lineas].join("\r\n")], { type: "text/csv;charset=utf-8" }));
  enlace.download = `ManagerLAB_prestamos_${fechaISO(new Date())}.csv`;
  enlace.click();
  setTimeout(() => URL.revokeObjectURL(enlace.href), 1000);
});

function escapar(texto) {
  return String(texto).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* ---------------------------------------------------------
   Arranque: carga y actualiza cada minuto
   --------------------------------------------------------- */
if (window.lucide) lucide.createIcons();
cargarDatos();
setInterval(cargarDatos, 60000);
