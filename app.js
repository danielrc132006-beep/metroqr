/* =========================================================
   ManagerLAB · Lógica de la aplicación
   Pantallas: Registrar préstamo (con escáner QR) y Generar credencial.
   Backend: API de Google Apps Script definida en config.js
   ========================================================= */

// Atajo para buscar elementos por id
const $ = (id) => document.getElementById(id);

// Estado general de la aplicación
const estado = {
  catalogo: [],        // [{clave, instrumento, notas}]
  areas: [],           // [{area, jefe}]
  personal: [],        // [{matricula, nombre, area, jefe}]
  trabajador: null,    // trabajador identificado en el préstamo actual
  instrumento: null,   // instrumento elegido
  cantidad: 1,
  guardando: false,    // evita registros dobles
  credencialLista: false,
  modo: "prestar",     // "prestar" o "devolver"
  prestamos: null,     // historial de la hoja Prestamos (null mientras carga)
  devolviendo: false,  // evita devoluciones dobles
  inicioRegistro: null, // momento en que se leyó la credencial (para el cronómetro)
  catFiltro: "Todas",   // categoría elegida en el catálogo
  catActual: null,      // instrumento abierto en el detalle del catálogo
  instrumentoPreferido: null, // elegido desde el catálogo para el siguiente préstamo
  calibraciones: [],    // historial de la hoja Calibraciones
  incidencias: [],      // instrumentos que regresaron dañados o incompletos
  condiciones: {},      // cómo regresa cada préstamo en la devolución: {folio: {condicion, observacion, piezas}}
  pin: null,            // PIN del encargado (pestaña Mantenimiento)
  mantActual: null,     // incidencia o instrumento abierto en el diálogo de mantenimiento
  calibrarDespues: null // instrumento elegido desde el catálogo antes de escribir el PIN
};

const HORAS_TURNO = 8;   // un préstamo con más horas fuera se marca en ámbar
const DIAS_AVISO = 30;   // una calibración que vence en 30 días o menos se marca "por vencer"

const CANTIDAD_MIN = 1;
const CANTIDAD_MAX = 10;

/* ---------------------------------------------------------
   1. Comunicación con la API
   --------------------------------------------------------- */

// Consulta con GET: catalogo, areas, personal o prestamos
async function consultarApi(accion) {
  const url = `${CONFIG.API_URL}?accion=${encodeURIComponent(accion)}&clave=${encodeURIComponent(CONFIG.API_CLAVE)}`;
  const respuesta = await fetch(url, { redirect: "follow" });
  const datos = await respuesta.json();
  marcarConexion(true);
  if (!datos.ok) throw new Error(datos.error || "La API devolvió un error.");
  return datos.datos;
}

// Envío con POST. Se usa 'text/plain' para que el navegador no haga la
// petición previa de CORS que Apps Script no sabe contestar.
async function enviarApi(cuerpo) {
  const respuesta = await fetch(CONFIG.API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ clave: CONFIG.API_CLAVE, ...cuerpo }),
    redirect: "follow"     // Apps Script responde con una redirección
  });
  const datos = await respuesta.json();
  marcarConexion(true);
  return datos;            // {ok:true,...} o {ok:false, error}
}

// Pinta el indicador de conexión de la barra superior
function marcarConexion(conectado) {
  const caja = $("conexion");
  caja.classList.toggle("ok", conectado);
  caja.classList.toggle("error", !conectado);
  caja.querySelector(".conexion-texto").textContent = conectado ? "Conectado" : "Sin conexión";
}

// Carga los catálogos al abrir la aplicación
async function cargarDatosIniciales() {
  const [catalogo, areas, personal] = await Promise.allSettled([
    consultarApi("catalogo"), consultarApi("areas"), consultarApi("personal")
  ]);
  if ([catalogo, areas, personal].some((r) => r.status === "rejected")) marcarConexion(false);

  if (catalogo.status === "fulfilled") { estado.catalogo = catalogo.value; pintarCatalogo(); pintarVistaCatalogo(); }
  else $("catalogo").innerHTML = '<p class="cargando">No se pudo cargar el catálogo. Revise la conexión y recargue la página.</p>';

  if (areas.status === "fulfilled") { estado.areas = areas.value; pintarListasAreas(); }
  if (personal.status === "fulfilled") estado.personal = personal.value;
  cargarPrestamos().catch(() => {});   // el historial se pide aparte para no retrasar el arranque
  cargarMantenimiento().then(pintarTodo).catch(() => {});
}

// Calibraciones e incidencias (bloquean o restan piezas en el catálogo)
async function cargarMantenimiento() {
  const [calibraciones, incidencias] = await Promise.all([consultarApi("calibraciones"), consultarApi("incidencias")]);
  estado.calibraciones = calibraciones;
  estado.incidencias = incidencias;
}

// Vuelve a pintar todo lo que depende de la disponibilidad de los instrumentos
function pintarTodo() {
  pintarCatalogo();
  pintarVistaCatalogo();
  pintarContadorMant();
  if (!$("mantContenido").hidden) pintarMantenimiento();
}

// Revisa la conexión cada minuto
setInterval(() => consultarApi("areas").catch(() => marcarConexion(false)), 60000);
window.addEventListener("offline", () => marcarConexion(false));

/* ---------------------------------------------------------
   2. Navegación entre pestañas y pasos
   --------------------------------------------------------- */

document.querySelectorAll(".pestana[data-pantalla]").forEach((boton) => {
  boton.addEventListener("click", () => mostrarPantalla(boton.dataset.pantalla));
});

function mostrarPantalla(idPantalla) {
  document.querySelectorAll(".pestana[data-pantalla]").forEach((b) => b.setAttribute("aria-selected", b.dataset.pantalla === idPantalla));
  document.querySelectorAll(".pantalla").forEach((p) => (p.hidden = p.id !== idPantalla));
  // La cámara solo se usa en el paso 1 del préstamo
  if (idPantalla === "pantallaPrestamo" && !$("paso1").hidden) iniciarCamara();
  else detenerCamara();
  // El catálogo se pinta con lo que ya hay y se actualiza la disponibilidad con la hoja
  if (idPantalla === "pantallaCatalogo") {
    pintarVistaCatalogo();
    cargarPrestamos().then(pintarVistaCatalogo).catch(() => {});
  }
  if (idPantalla === "pantallaMantenimiento") {
    aplicarAccesoMant();
    Promise.all([cargarMantenimiento(), cargarPrestamos()]).then(pintarTodo).catch(() => {});
  }
}

// Muestra el paso indicado: 1 (escanear), 2 (elegir y confirmar) o "exito"
function irAPaso(paso) {
  $("paso1").hidden = paso !== 1;
  $("paso2").hidden = paso !== 2;
  $("pasoExito").hidden = paso !== "exito";
  actualizarProgreso();
  if (paso === 1) iniciarCamara(); else detenerCamara();
  window.scrollTo({ top: 0 });
}

// Actualiza el indicador 1 → 2 → 3 según lo que ya se completó
function actualizarProgreso() {
  const enExito = !$("pasoExito").hidden;
  const pasoActual = enExito ? 4 : !estado.trabajador ? 1 : !estado.instrumento ? 2 : 3;
  document.querySelectorAll("#progreso li").forEach((li) => {
    const n = Number(li.dataset.paso);
    li.classList.toggle("hecho", n < pasoActual);
    li.classList.toggle("activo", n === pasoActual);
    li.querySelector(".progreso-num").innerHTML = n < pasoActual ? '<i data-lucide="check" aria-hidden="true"></i>' : n;
    li.setAttribute("aria-current", n === pasoActual ? "step" : "false");
  });
  pintarIconos();
}

/* ---------------------------------------------------------
   3. Escáner de credenciales (html5-qrcode)
   --------------------------------------------------------- */

let lector = null;          // instancia de Html5Qrcode
let camaraActiva = false;
let ultimoTextoInvalido = "";
let temporizadorAviso = null;

async function iniciarCamara() {
  if (camaraActiva || $("paso1").hidden || $("pantallaPrestamo").hidden) return;
  if (!window.Html5Qrcode) return mostrarCamaraInactiva("No se pudo cargar el lector de QR. Revise la conexión a internet.");
  if (!window.isSecureContext) return mostrarCamaraInactiva("La cámara solo funciona con https (GitHub Pages) o en localhost.");

  try {
    lector = lector || new Html5Qrcode("lector", { verbose: false, formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE] });
    camaraActiva = true;
    $("visorMensaje").textContent = "Iniciando cámara…";
    await lector.start({ facingMode: "environment" }, { fps: 12 }, alLeerQR, () => {});
    $("visorInactivo").hidden = true;
    $("visorMensaje").textContent = "Acerque la credencial";
  } catch (error) {
    camaraActiva = false;
    const permisoNegado = /NotAllowed|Permission/i.test(String(error));
    mostrarCamaraInactiva(permisoNegado
      ? "Se negó el permiso de cámara. Actívelo en Ajustes › Safari › Cámara y toque Reintentar."
      : "No se encontró una cámara disponible. Puede buscar al trabajador por matrícula.");
  }
}

async function detenerCamara() {
  if (!camaraActiva) return;
  camaraActiva = false;
  try { await lector.stop(); } catch (e) { /* ya estaba detenida */ }
}

function mostrarCamaraInactiva(mensaje) {
  $("visorInactivoTexto").textContent = mensaje;
  $("btnActivarCamara").textContent = "Reintentar";
  $("visorInactivo").hidden = false;
  $("visorMensaje").textContent = "";
}
$("btnActivarCamara").addEventListener("click", iniciarCamara);

// Valida el texto del QR. Formato: {"m":"matrícula","n":"nombre","a":"área","j":"jefe"}
function leerCredencial(texto) {
  try {
    // qrcode.js agrega una marca BOM al inicio cuando hay acentos; se quita aquí
    const datos = JSON.parse(String(texto).replace(/^(﻿|ï»¿)/, ""));
    const valido = /^\d{5,8}$/.test(datos.m) && typeof datos.n === "string" && datos.n.trim() !== ""
      && typeof datos.a === "string" && typeof datos.j === "string";
    return valido ? { matricula: datos.m, nombre: datos.n.trim(), area: datos.a, jefe: datos.j } : null;
  } catch (e) {
    return null;
  }
}

// Se ejecuta cada vez que la cámara detecta un código QR
function alLeerQR(texto) {
  const inicio = performance.now();   // prueba P3: tiempo desde la detección
  if (!estado.trabajador && $("paso1").hidden === false) {
    const trabajador = leerCredencial(texto);
    if (!trabajador) return avisarQRInvalido(texto);   // la cámara sigue encendida
    identificarTrabajador(trabajador, inicio);
  }
}

function avisarQRInvalido(texto) {
  if (texto === ultimoTextoInvalido && !$("visorAviso").hidden) return;
  ultimoTextoInvalido = texto;
  $("visorAviso").hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { $("visorAviso").hidden = true; ultimoTextoInvalido = ""; }, 2200);
}

// Muestra la tarjeta del trabajador y mide cuánto tardó en aparecer
function identificarTrabajador(trabajador, inicio) {
  estado.trabajador = trabajador;
  estado.instrumento = null;
  estado.cantidad = CANTIDAD_MIN;
  pintarTrabajador(trabajador);
  pintarCatalogo();
  actualizarCantidad();
  // Si se eligió un instrumento desde el catálogo, ya queda seleccionado
  if (estado.instrumentoPreferido && estado.modo === "prestar") {
    const item = estado.catalogo.find((c) => c.clave === estado.instrumentoPreferido.clave);
    if (item && sePuedePrestar(item)) seleccionarInstrumento(item);
    quitarPreseleccion();
  }
  $("errorPrestamo").hidden = true;
  $("errorDevolucion").hidden = true;
  aplicarModo();
  irAPaso(2);
  // El cronómetro corre desde la lectura de la credencial hasta que se toca Registrar
  estado.inicioRegistro = inicio;
  if (estado.modo === "prestar") iniciarCronometro(); else detenerCronometro();
  // Historial: se muestra lo que ya hay y se actualiza con la hoja
  pintarHistorial();
  cargarPrestamos().then(() => { pintarHistorial(); pintarCatalogo(); }).catch(() => {
    if (!estado.prestamos) $("historial").innerHTML = '<p class="nota">No se pudo cargar el historial.</p>';
  });
  // Se mide cuando el navegador ya dibujó los datos en pantalla
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const segundos = (performance.now() - inicio) / 1000;
    $("tiempoLectura").textContent = `Datos mostrados en ${segundos.toFixed(2)} s desde la lectura`;
  }));
}

function obtenerIniciales(nombre) {
  return nombre.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
}

function pintarTrabajador(t) {
  $("trabIniciales").textContent = obtenerIniciales(t.nombre);
  $("trabNombre").textContent = t.nombre;
  $("trabMatricula").textContent = t.matricula;
  $("trabArea").textContent = t.area;
  $("trabJefe").textContent = t.jefe;
}

$("btnCambiarTrabajador").addEventListener("click", reiniciarPrestamo);

/* ---------------------------------------------------------
   4. Búsqueda por matrícula (respaldo si el QR no lee)
   --------------------------------------------------------- */

$("btnMostrarBusqueda").addEventListener("click", () => {
  const form = $("formBusqueda");
  form.hidden = !form.hidden;
  $("btnMostrarBusqueda").setAttribute("aria-expanded", String(!form.hidden));
  if (!form.hidden) $("inputBusqueda").focus();
});
$("inputBusqueda").addEventListener("input", (e) => (e.target.value = e.target.value.replace(/\D/g, "")));

$("formBusqueda").addEventListener("submit", async (e) => {
  e.preventDefault();
  const inicio = performance.now();
  const matricula = $("inputBusqueda").value.trim();
  const error = $("errorBusqueda");
  if (!/^\d{5,8}$/.test(matricula)) { error.textContent = "Escriba una matrícula de 5 a 8 dígitos."; error.hidden = false; return; }

  // Si la lista de personal no está cargada, se pide otra vez a la API
  if (!estado.personal.length) {
    try { estado.personal = await consultarApi("personal"); }
    catch (err) { marcarConexion(false); error.textContent = "No se pudo consultar el personal. Revise la conexión."; error.hidden = false; return; }
  }
  const encontrado = estado.personal.find((p) => String(p.matricula) === matricula);
  if (!encontrado) { error.textContent = `No hay ningún trabajador con la matrícula ${matricula}.`; error.hidden = false; return; }

  error.hidden = true;
  $("inputBusqueda").value = "";
  identificarTrabajador({ ...encontrado, matricula: String(encontrado.matricula) }, inicio);
});

/* ---------------------------------------------------------
   5. Catálogo de instrumentos y cantidad
   --------------------------------------------------------- */

// Crea una tarjeta por instrumento (sin fotos, con ícono genérico)
function pintarCatalogo() {
  const contenedor = $("catalogo");
  if (!estado.catalogo.length) return;
  contenedor.innerHTML = "";
  estado.catalogo.forEach((item) => {
    const tarjeta = document.createElement("button");
    tarjeta.type = "button";
    tarjeta.className = "instrumento";
    tarjeta.setAttribute("role", "radio");
    tarjeta.setAttribute("aria-checked", String(estado.instrumento?.clave === item.clave));
    tarjeta.innerHTML = `
      <span class="instrumento-marca" aria-hidden="true"><i data-lucide="check"></i></span>
      <i data-lucide="ruler" aria-hidden="true"></i>
      <span class="instrumento-nombre"></span>
      <span class="instrumento-clave"></span>
      <span class="instrumento-nota"></span>`;
    // textContent evita que datos de la hoja se interpreten como HTML
    tarjeta.querySelector(".instrumento-nombre").textContent = item.instrumento;
    tarjeta.querySelector(".instrumento-clave").textContent = item.clave;
    tarjeta.querySelector(".instrumento-nota").textContent = item.notas || "";
    // Sin piezas o con la calibración vencida no se puede elegir; se explica por qué
    const d = disponibilidad(item), cal = calibracion(item);
    if (d.nivel === "agotado") {
      tarjeta.disabled = true;
      tarjeta.classList.add("bloqueado");
      tarjeta.append(crear("span", "instrumento-estado agotado", d.texto));
    } else if (cal.nivel === "porVencer") tarjeta.append(crear("span", "instrumento-estado parcial", cal.texto));
    tarjeta.addEventListener("click", () => seleccionarInstrumento(item));
    contenedor.appendChild(tarjeta);
  });
  pintarIconos();
}

function seleccionarInstrumento(item) {
  estado.instrumento = item;
  document.querySelectorAll(".instrumento").forEach((t, i) => {
    t.setAttribute("aria-checked", String(estado.catalogo[i].clave === item.clave));
  });
  estado.cantidad = Math.min(estado.cantidad, cantidadMaxima());
  actualizarCantidad();
  $("errorPrestamo").hidden = true;
}

// Algunos instrumentos se prestan solo como juego (la nota dice "cantidad 1")
// Tampoco se prestan más piezas de las que hay libres
function cantidadMaxima() {
  if (!estado.instrumento) return CANTIDAD_MAX;
  const tope = /cantidad 1\b/i.test(estado.instrumento.notas || "") ? 1 : CANTIDAD_MAX;
  const libres = disponibilidad(estado.instrumento).libres;
  return Math.max(CANTIDAD_MIN, libres == null ? tope : Math.min(tope, libres));
}

function actualizarCantidad() {
  $("cantidadValor").textContent = estado.cantidad;
  $("btnMenos").disabled = estado.cantidad <= CANTIDAD_MIN;
  $("btnMas").disabled = estado.cantidad >= cantidadMaxima();
  const listo = Boolean(estado.trabajador && estado.instrumento);
  $("btnRegistrar").disabled = !listo || estado.guardando;
  $("ayudaRegistrar").hidden = listo;
  actualizarProgreso();
}

$("btnMenos").addEventListener("click", () => { estado.cantidad = Math.max(CANTIDAD_MIN, estado.cantidad - 1); actualizarCantidad(); });
$("btnMas").addEventListener("click", () => { estado.cantidad = Math.min(cantidadMaxima(), estado.cantidad + 1); actualizarCantidad(); });

/* ---------------------------------------------------------
   6. Registrar el préstamo
   --------------------------------------------------------- */

$("btnRegistrar").addEventListener("click", registrarPrestamo);

async function registrarPrestamo() {
  if (estado.guardando || !estado.trabajador || !estado.instrumento) return;
  estado.guardando = true;
  // Se detiene el cronómetro: el encargado ya confirmó el préstamo
  detenerCronometro();
  const duracion = segundosDesde(estado.inicioRegistro);
  $("cronometroValor").textContent = formatearDuracion(duracion);
  const boton = $("btnRegistrar");
  boton.disabled = true;
  boton.querySelector("span").textContent = "Guardando...";
  $("errorPrestamo").hidden = true;
  const inicioGuardado = performance.now();
  let registrado = false;

  try {
    const respuesta = await enviarApi({
      accion: "prestamo",
      matricula: estado.trabajador.matricula,
      instrumento: estado.instrumento.instrumento,
      cantidad: estado.cantidad,
      duracion: duracion          // segundos, para comparar contra el vale de papel
    });
    registrado = respuesta.ok;
    if (respuesta.ok) mostrarExito(respuesta, duracion, segundosDesde(inicioGuardado));
    else mostrarErrorPrestamo(respuesta.error || "La API rechazó el préstamo.");
  } catch (error) {
    marcarConexion(false);
    mostrarErrorPrestamo("No se pudo conectar con el servidor. Revise la conexión e intente de nuevo.");
  } finally {
    if (!registrado) iniciarCronometro();   // si falló, el tiempo sigue contando hasta que se registre
    estado.guardando = false;
    boton.querySelector("span").textContent = "Registrar préstamo";
    actualizarCantidad();
  }
}

function mostrarErrorPrestamo(mensaje) {
  $("errorPrestamo").textContent = `No se registró el préstamo: ${mensaje}`;
  $("errorPrestamo").hidden = false;
}

// Pantalla de éxito: folio grande y regreso automático en 5 s
let temporizadorRegreso = null;
function mostrarExito(respuesta, duracion, guardado) {
  const t = respuesta.trabajador || estado.trabajador;
  // Se agrega al historial local para que aparezca sin recargar
  if (estado.prestamos) estado.prestamos.push(normalizarPrestamo({
    folio: respuesta.folio, fecha: respuesta.fecha, hora: respuesta.hora, matricula: t.matricula,
    nombre: t.nombre, area: t.area, jefe: t.jefe, instrumento: estado.instrumento.instrumento, cantidad: estado.cantidad, estado: "Prestado", duracion_seg: duracion
  }));
  $("exitoTiempo").textContent = `Registrado en ${formatearDuracion(duracion)} · guardado en el servidor en ${guardado.toFixed(1)} s`;
  $("exitoTiempo").hidden = false;
  $("exitoTitulo").textContent = "Préstamo registrado";
  $("exitoEtiqueta").textContent = "Folio";
  $("exitoBoton").textContent = "Nuevo préstamo";
  $("exitoFolio").textContent = respuesta.folio;
  $("exitoResumen").textContent =
    `${estado.cantidad} × ${estado.instrumento.instrumento} para ${t.nombre} (${t.matricula}) · ${respuesta.fecha} a las ${respuesta.hora} h`;
  irAPaso("exito");
  iniciarCuentaRegresiva();
}

// Regresa al paso 1 después de 5 segundos en la pantalla de éxito
function iniciarCuentaRegresiva() {
  $("btnNuevoPrestamo").focus();
  let segundos = 5;
  $("exitoCuenta").textContent = `Regresa al inicio en ${segundos} s`;
  clearInterval(temporizadorRegreso);
  temporizadorRegreso = setInterval(() => {
    segundos -= 1;
    $("exitoCuenta").textContent = `Regresa al inicio en ${segundos} s`;
    if (segundos <= 0) reiniciarPrestamo();
  }, 1000);
}

// Limpia todo y vuelve al paso 1
function reiniciarPrestamo() {
  clearInterval(temporizadorRegreso);
  detenerCronometro();
  estado.inicioRegistro = null;
  $("cronometroValor").textContent = formatearDuracion(0);
  estado.trabajador = null;
  estado.instrumento = null;
  estado.cantidad = CANTIDAD_MIN;
  estado.condiciones = {};
  $("tiempoLectura").textContent = "";
  irAPaso(1);
}
$("btnNuevoPrestamo").addEventListener("click", reiniciarPrestamo);

/* ---------------------------------------------------------
   Cronómetro del registro (para comparar contra el vale de papel)
   --------------------------------------------------------- */

let temporizadorCronometro = null;

// Segundos transcurridos desde un momento de performance.now(), con un decimal
function segundosDesde(inicio) {
  return inicio == null ? 0 : Math.round((performance.now() - inicio) / 100) / 10;
}

// 12.4 → "0:12.4"   ·   75.2 → "1:15.2"
function formatearDuracion(segundos) {
  const min = Math.floor(segundos / 60);
  const seg = (segundos % 60).toFixed(1).padStart(4, "0");
  return `${min}:${seg}`;
}

function iniciarCronometro() {
  clearInterval(temporizadorCronometro);
  temporizadorCronometro = setInterval(() => {
    $("cronometroValor").textContent = formatearDuracion(segundosDesde(estado.inicioRegistro));
  }, 100);
}

function detenerCronometro() {
  clearInterval(temporizadorCronometro);
}

/* ---------------------------------------------------------
   7. Devoluciones e historial del trabajador
   --------------------------------------------------------- */

// Selector Prestar / Devolver de la pantalla de inicio
document.querySelectorAll(".modo button").forEach((boton) => boton.addEventListener("click", () => {
  estado.modo = boton.dataset.modo;
  aplicarModo();
}));

// Cambia textos y secciones según el modo elegido
function aplicarModo() {
  const devolver = estado.modo === "devolver";
  document.querySelectorAll(".modo button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.modo === estado.modo)));
  $("tituloInicio").textContent = devolver ? "Registrar devolución" : "Registrar préstamo";
  $("textoInicio").textContent = devolver
    ? "Escanee la credencial de quien regresa el instrumento para ver lo que tiene pendiente."
    : "Pida al trabajador su credencial y acérquela a la cámara. Los datos aparecen solos.";
  $("progreso").hidden = devolver;   // los 3 pasos son del préstamo
  document.querySelector(".eleccion").hidden = devolver;
  document.querySelector(".cantidad").hidden = devolver;
  $("accionPrestamo").hidden = devolver;
  $("panelDevolucion").hidden = !devolver;
  $("accionDevolucion").hidden = !devolver;
  if (estado.trabajador) pintarHistorial();
}

// Pide a la API todos los préstamos (incluye estado y datos de devolución)
async function cargarPrestamos() {
  const datos = await consultarApi("prestamos");
  estado.prestamos = datos.map(normalizarPrestamo);
  return estado.prestamos;
}

// Los préstamos anteriores a la columna "estado" se consideran prestados
function normalizarPrestamo(p) {
  return { ...p, matricula: String(p.matricula), cantidad: Number(p.cantidad) || 0, estado: p.estado || "Prestado" };
}

// Compara matrículas ignorando ceros a la izquierda (igual que el servidor)
const mismaMatricula = (a, b) => String(a).replace(/^0+/, "") === String(b).replace(/^0+/, "");

// Horas y minutos desde que salió el instrumento: "2 h 15 min", "3 d"
function tiempoFuera(p) {
  const minutos = Math.max(0, Math.round((Date.now() - new Date(`${p.fecha}T${p.hora}:00`)) / 60000));
  if (isNaN(minutos)) return { texto: "—", vencido: false };
  const texto = minutos < 60 ? `${minutos} min`
    : minutos < 1440 ? `${Math.floor(minutos / 60)} h ${minutos % 60} min`
    : `${Math.floor(minutos / 1440)} d ${Math.floor((minutos % 1440) / 60)} h`;
  return { texto, vencido: minutos > HORAS_TURNO * 60 };
}

function pendientesDelTrabajador() {
  if (!estado.prestamos || !estado.trabajador) return [];
  return estado.prestamos
    .filter((p) => mismaMatricula(p.matricula, estado.trabajador.matricula) && p.estado === "Prestado")
    .sort((a, b) => (a.fecha + a.hora).localeCompare(b.fecha + b.hora));   // el más antiguo primero
}

// Crea un elemento con clase y texto seguro (textContent)
function crear(etiqueta, clase, texto) {
  const el = document.createElement(etiqueta);
  if (clase) el.className = clase;
  if (texto !== undefined) el.textContent = texto;
  return el;
}

// Fila de un préstamo pendiente con su botón "Devolver"
function crearFilaPendiente(p, grande) {
  const fila = crear("div", "pendiente" + (grande ? " grande" : ""));
  fila.setAttribute("role", "listitem");
  const t = tiempoFuera(p);
  if (t.vencido) fila.classList.add("vencido");
  const info = crear("div", "pendiente-info");
  info.append(crear("strong", "", `${p.cantidad} × ${p.instrumento}`), crear("span", "pendiente-detalle", `${p.folio} · salió ${p.fecha} ${p.hora} · hace ${t.texto}`));
  if (t.vencido) info.append(crear("span", "pendiente-alerta", `Lleva más de ${HORAS_TURNO} h fuera`));
  const boton = crear("button", "btn btn-secundario pendiente-btn");
  boton.type = "button";
  boton.innerHTML = '<i data-lucide="log-in" aria-hidden="true"></i><span>Devolver</span>';
  boton.setAttribute("aria-label", `Devolver ${p.instrumento}, folio ${p.folio}`);
  boton.addEventListener("click", () => devolverPrestamos([p], boton));
  fila.append(info, boton);
  if (grande) fila.append(crearCondicion(p));
  return fila;
}

// Bien / Dañado / Incompleto: lo que el trabajador declara. El encargado lo confirma al revisarlo.
function crearCondicion(p) {
  const c = estado.condiciones[p.folio] || (estado.condiciones[p.folio] = { condicion: "Bien", observacion: "" });
  const caja = crear("div", "condicion");
  const grupo = crear("div", "condicion-opciones");
  grupo.setAttribute("role", "radiogroup");
  grupo.setAttribute("aria-label", `Cómo regresa ${p.instrumento}`);
  const detalle = crear("div", "condicion-detalle");

  const pintar = () => {
    grupo.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.valor === c.condicion)));
    detalle.hidden = c.condicion === "Bien";
  };
  [["Bien", "circle-check"], ["Dañado", "triangle-alert"], ["Incompleto", "puzzle"]].forEach(([valor, icono]) => {
    const b = crear("button", "condicion-" + (valor === "Bien" ? "bien" : "mal"));
    b.type = "button";
    b.setAttribute("role", "radio");
    b.dataset.valor = valor;
    b.innerHTML = `<i data-lucide="${icono}" aria-hidden="true"></i>`;
    b.append(valor);
    b.addEventListener("click", () => {
      c.condicion = valor;
      pintar();
      if (valor !== "Bien") detalle.querySelector("input").focus();
    });
    grupo.append(b);
  });

  const id = "obs-" + p.folio;
  const campo = crear("div", "grupo");
  const etiqueta = crear("label", "", "Comentario (opcional)");
  etiqueta.htmlFor = id;
  const input = crear("input", "campo");
  Object.assign(input, { id, maxLength: 200, autocomplete: "off", placeholder: "Ej. se cayó, falta el estuche", value: c.observacion });
  input.addEventListener("input", () => (c.observacion = input.value));
  campo.append(etiqueta, input);
  detalle.append(campo);
  caja.append(grupo, detalle);
  pintar();
  return caja;
}

// Pinta el historial en la tarjeta del trabajador y, en modo devolución, la lista de pendientes
function pintarHistorial() {
  const caja = $("historial");
  if (!estado.trabajador) return;
  if (!estado.prestamos) { caja.innerHTML = '<p class="nota">Cargando historial…</p>'; return; }

  const devolver = estado.modo === "devolver";
  const pendientes = pendientesDelTrabajador();
  const recientes = estado.prestamos
    .filter((p) => mismaMatricula(p.matricula, estado.trabajador.matricula))
    .sort((a, b) => (b.fecha + b.hora + b.folio).localeCompare(a.fecha + a.hora + a.folio))
    .slice(0, 3);
  caja.innerHTML = "";

  // Aviso de pendientes (en modo préstamo; en modo devolución van en el panel grande)
  if (pendientes.length && !devolver) {
    const aviso = crear("div", "aviso-pendientes");
    aviso.append(crear("p", "aviso-pendientes-titulo", pendientes.length === 1 ? "Tiene 1 instrumento sin devolver" : `Tiene ${pendientes.length} instrumentos sin devolver`));
    const lista = crear("div", "pendientes");
    lista.setAttribute("role", "list");
    pendientes.forEach((p) => lista.append(crearFilaPendiente(p, false)));
    aviso.append(lista);
    caja.append(aviso);
  }

  // Devoluciones donde dijo "Bien" y el encargado encontró un problema
  const discrepancias = estado.prestamos.filter((p) => mismaMatricula(p.matricula, estado.trabajador.matricula) && p.discrepancia === "Sí").length;
  if (discrepancias) caja.append(crear("p", "aviso-discrepancia", `${plural(discrepancias, "devolución", "devoluciones")} con discrepancia`));

  if (!recientes.length) caja.append(crear("p", "nota", "Es su primer préstamo."));
  else {
    const lista = crear("ul", "recientes");
    recientes.forEach((p) => {
      const li = crear("li", "reciente");
      const texto = crear("span", "reciente-texto");
      texto.append(crear("span", "", `${p.cantidad} × ${p.instrumento}`), crear("small", "", `${p.fecha} · ${p.folio}`));
      const clase = { Devuelto: "devuelto", "Por revisar": "revisar" }[p.estado] || "prestado";
      li.append(texto, crear("span", "insignia-estado " + clase, p.estado));
      lista.append(li);
    });
    caja.append(crear("p", "recientes-titulo", "Últimos préstamos"), lista);
  }

  // Panel grande del modo devolución
  const panel = $("pendientes");
  panel.innerHTML = "";
  if (!pendientes.length) panel.append(crear("p", "vacio-pendientes", "No tiene instrumentos pendientes de devolver."));
  pendientes.forEach((p) => panel.append(crearFilaPendiente(p, true)));
  $("btnDevolverTodos").disabled = !pendientes.length || estado.devolviendo;
  $("btnDevolverTodos").querySelector("span").textContent = pendientes.length > 1 ? `Devolver todos (${pendientes.length})` : pendientes.length === 1 ? `Devolver ${pendientes[0].folio}` : "Sin pendientes";
  pintarIconos();
}

$("btnDevolverTodos").addEventListener("click", () => devolverPrestamos(pendientesDelTrabajador(), $("btnDevolverTodos")));

// El iPad recuerda quién recibe, para no escribirlo en cada devolución
try { $("campoRecibio").value = localStorage.getItem("managerlab.recibio") || ""; } catch (e) { /* sin almacenamiento */ }
$("campoRecibio").addEventListener("input", () => {
  try { localStorage.setItem("managerlab.recibio", $("campoRecibio").value.trim()); } catch (e) { /* sin almacenamiento */ }
});

// Envía una devolución por cada préstamo (uno tras otro) y actualiza la pantalla
async function devolverPrestamos(lista, boton) {
  if (estado.devolviendo || !lista.length) return;
  estado.devolviendo = true;
  const textoOriginal = boton.querySelector("span").textContent;
  boton.disabled = true;
  $("errorDevolucion").hidden = true;
  const recibio = $("campoRecibio").value.trim();
  const devueltos = [];

  try {
    for (const [i, p] of lista.entries()) {
      boton.querySelector("span").textContent = lista.length > 1 ? `Guardando ${i + 1} de ${lista.length}...` : "Guardando...";
      const c = estado.condiciones[p.folio] || { condicion: "Bien", observacion: "" };
      const respuesta = await enviarApi({ accion: "devolucion", folio: p.folio, recibio, condicion: c.condicion, observacion: c.observacion.trim() });
      if (!respuesta.ok) throw new Error(respuesta.error || "La API rechazó la devolución.");
      // Queda "Por revisar": no se presta hasta que el encargado lo revise en Mantenimiento
      Object.assign(p, { estado: "Por revisar", fecha_devolucion: respuesta.fecha_devolucion, hora_devolucion: respuesta.hora_devolucion, recibio, declaracion: respuesta.declaracion || c.condicion });
      delete estado.condiciones[p.folio];
      devueltos.push(p);
    }
  } catch (error) {
    if (error instanceof TypeError) marcarConexion(false);   // falla de red
    const mensaje = error instanceof TypeError ? "No se pudo conectar con el servidor. Revise la conexión e intente de nuevo." : error.message;
    $("errorDevolucion").textContent = `No se registró la devolución: ${mensaje}`;
    $("errorDevolucion").hidden = estado.modo !== "devolver";
    if (estado.modo !== "devolver") mostrarAviso(`No se registró la devolución: ${mensaje}`);
  } finally {
    estado.devolviendo = false;
    if (boton.isConnected) { boton.disabled = false; boton.querySelector("span").textContent = textoOriginal; }
  }

  if (!devueltos.length) return pintarHistorial();
  pintarTodo();
  // En modo devolución, si ya no queda nada pendiente se muestra la pantalla de éxito
  if (estado.modo === "devolver" && !pendientesDelTrabajador().length) return mostrarExitoDevolucion(devueltos);
  mostrarAviso((devueltos.length === 1 ? `${devueltos[0].folio} recibido` : `${devueltos.length} instrumentos recibidos`) + " · pendiente de revisión del encargado");
  pintarHistorial();
}

function mostrarExitoDevolucion(devueltos) {
  const ultimo = devueltos[devueltos.length - 1];
  $("exitoTitulo").textContent = "Devolución recibida";
  $("exitoEtiqueta").textContent = devueltos.length === 1 ? "Folio" : "Instrumentos devueltos";
  $("exitoFolio").textContent = devueltos.length === 1 ? ultimo.folio : devueltos.length;
  $("exitoResumen").textContent = `${devueltos.map((p) => `${p.cantidad} × ${p.instrumento}`).join(", ")} de ${estado.trabajador.nombre} · ${ultimo.fecha_devolucion} a las ${ultimo.hora_devolucion} h. `
    + "Deje el instrumento en la charola de devoluciones: el encargado lo revisará.";
  $("exitoBoton").textContent = "Nueva devolución";
  $("exitoTiempo").hidden = true;
  irAPaso("exito");
  iniciarCuentaRegresiva();
}

/* ---------------------------------------------------------
   8. Catálogo de instrumentos (consulta y disponibilidad)
   --------------------------------------------------------- */

const mismoNombre = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// Piezas prestadas ahora, existencias y disponibles de un instrumento.
// Las piezas con una incidencia abierta (dañadas o esperando calibración) tampoco están disponibles.
// Sin la columna "existencias" no se inventa el total: solo se sabe si hay piezas fuera.
function disponibilidad(item) {
  const delItem = (estado.prestamos || []).filter((p) => mismoNombre(p.instrumento, item.instrumento));
  const abiertos = delItem.filter((p) => p.estado === "Prestado");
  const fuera = abiertos.reduce((s, p) => s + p.cantidad, 0);
  const revision = incidenciasDe(item);
  // Devueltas por el trabajador pero aún sin revisar: cuentan como "en revisión"
  const porRevisar = delItem.filter((p) => p.estado === "Por revisar").reduce((s, p) => s + p.cantidad, 0);
  const enRevision = revision.reduce((s, i) => s + (parseInt(i.piezas, 10) || 1), 0) + porRevisar;
  const base = { abiertos, revision, libres: null };
  if (calibracion(item).nivel === "vencida") return { ...base, nivel: "agotado", texto: "Calibración vencida", libres: 0 };

  const total = parseInt(item.existencias, 10);
  if (!(total > 0)) {
    return fuera || enRevision ? { ...base, nivel: "parcial", texto: [fuera && plural(fuera, "pieza prestada", "piezas prestadas"), enRevision && `${enRevision} en revisión`].filter(Boolean).join(" · ") }
                               : { ...base, nivel: "libre", texto: "Disponible" };
  }
  const libres = Math.max(0, total - fuera - enRevision);
  const extra = enRevision ? ` · ${enRevision} en revisión` : "";
  if (!fuera && !enRevision) return { ...base, libres, nivel: "libre", texto: `Disponible · ${plural(total, "pieza", "piezas")}` };
  if (!libres) return { ...base, libres, nivel: "agotado", texto: fuera ? `Agotado · ${fuera} de ${total} fuera${extra}` : `Sin piezas libres${extra}` };
  return { ...base, libres, nivel: "parcial", texto: `${libres} de ${total} disponibles${extra}` };
}

const sePuedePrestar = (item) => disponibilidad(item).nivel !== "agotado";

const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

function pintarVistaCatalogo() {
  const rejilla = $("catRejilla");
  if (!estado.catalogo.length) { rejilla.innerHTML = '<p class="cargando">Cargando catálogo…</p>'; return; }

  // Filtros: "Todas" más las categorías en el orden en que aparecen en la hoja
  const categorias = ["Todas", ...new Set(estado.catalogo.map((c) => c.categoria).filter(Boolean))];
  if (!categorias.includes(estado.catFiltro)) estado.catFiltro = "Todas";
  const filtros = $("catFiltros");
  filtros.innerHTML = "";
  categorias.forEach((cat) => {
    const b = crear("button", "", cat);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(cat === estado.catFiltro));
    b.addEventListener("click", () => { estado.catFiltro = cat; pintarVistaCatalogo(); });
    filtros.append(b);
  });

  const texto = $("catBuscar").value.trim().toLowerCase();
  const visibles = estado.catalogo.filter((c) =>
    (estado.catFiltro === "Todas" || c.categoria === estado.catFiltro) &&
    (!texto || [c.instrumento, c.clave, c.descripcion, c.categoria].some((v) => String(v || "").toLowerCase().includes(texto))));

  const prestadosAhora = estado.catalogo.filter((c) => disponibilidad(c).abiertos.length).length;
  $("catResumen").textContent = `${plural(estado.catalogo.length, "instrumento", "instrumentos")} · ${plural(categorias.length - 1, "categoría", "categorías")}`
    + (estado.prestamos ? ` · ${plural(prestadosAhora, "con piezas prestadas ahora", "con piezas prestadas ahora")}` : "");

  rejilla.innerHTML = "";
  if (!visibles.length) { rejilla.append(crear("p", "cargando", "Ningún instrumento coincide con la búsqueda.")); return; }
  visibles.forEach((item) => {
    const d = disponibilidad(item);
    const tarjeta = crear("button", "cat-tarjeta");
    tarjeta.type = "button";
    tarjeta.setAttribute("aria-label", `${item.instrumento}, ${d.texto}. Ver detalle`);
    const cabeza = crear("span", "cat-tarjeta-cabeza");
    cabeza.append(crear("span", "cat-categoria", item.categoria || "Sin categoría"), crear("span", "cat-clave", item.clave));
    tarjeta.append(cabeza, crear("span", "cat-nombre", item.instrumento));
    if (item.descripcion) tarjeta.append(crear("span", "cat-desc", item.descripcion));
    const pie = crear("span", "cat-tarjeta-pie");
    pie.append(crear("span", "cat-disponible " + d.nivel, d.texto));
    const cal = calibracion(item);
    if (cal.nivel === "porVencer") pie.append(crear("span", "cat-disponible parcial", cal.texto));
    else if (item.rango) pie.append(crear("span", "cat-rango", item.rango));
    tarjeta.append(pie);
    tarjeta.addEventListener("click", () => abrirDetalle(item));
    rejilla.append(tarjeta);
  });
}

$("catBuscar").addEventListener("input", pintarVistaCatalogo);

// Panel de detalle de un instrumento
function abrirDetalle(item) {
  estado.catActual = item;
  const d = disponibilidad(item);
  $("detMeta").textContent = [item.clave, item.categoria].filter(Boolean).join(" · ");
  $("detNombre").textContent = item.instrumento;
  $("detDisponible").textContent = d.texto;
  $("detDisponible").className = "cat-disponible " + d.nivel;
  $("detDescripcion").textContent = item.descripcion || "";
  $("detDescripcion").hidden = !item.descripcion;

  const ficha = $("detFicha");
  ficha.innerHTML = "";
  const cal = calibracion(item);
  [["Rango", item.rango], ["Resolución", item.resolucion], ["Existencias", item.existencias], ["Ubicación", item.ubicacion], ["Notas", item.notas],
   ["Calibración", cal.ultima ? `${cal.nivel === "vencida" ? "Venció" : "Vigente hasta"} el ${fechaCorta(cal.proxima)}` : "Sin registro"],
   ["Última calibración", cal.ultima && `${fechaCorta(fechaISO(cal.ultima.fecha))} · ${cal.ultima.calibro || "—"}`],
   ["Certificado", cal.ultima?.certificado], ["Frecuencia", item.frecuencia_meses && `Cada ${item.frecuencia_meses} meses`]]
    .filter(([, valor]) => valor)
    .forEach(([nombre, valor]) => { const fila = crear("div"); fila.append(crear("dt", "", nombre), crear("dd", "", valor)); ficha.append(fila); });

  // Quién lo tiene ahora y qué piezas están en revisión
  const quien = $("detQuien");
  quien.innerHTML = "";
  if (d.abiertos.length) {
    quien.append(crear("p", "cat-quien-titulo", "Lo tienen ahora"));
    d.abiertos.forEach((p) => quien.append(crear("p", "cat-quien-fila", `${p.cantidad} × · ${p.nombre} (${p.area}) · ${p.folio} · hace ${tiempoFuera(p).texto}`)));
  }
  if (d.revision.length) {
    quien.append(crear("p", "cat-quien-titulo rojo", "En revisión"));
    d.revision.forEach((i) => quien.append(crear("p", "cat-quien-fila", `${i.piezas || 1} × · ${i.id} · ${i.estado === "En calibración" ? "Esperando calibración" : i.condicion} · ${i.observacion}`)));
  }
  $("btnPrestarDesdeCatalogo").disabled = d.nivel === "agotado";
  $("btnPrestarDesdeCatalogo").querySelector("span").textContent = d.nivel !== "agotado" ? "Prestar este instrumento"
    : cal.nivel === "vencida" ? "No se presta: calibración vencida" : "Sin piezas disponibles";
  $("catDetalle").showModal();
}

// "Registrar calibración" desde la ficha: pide el PIN si todavía no se escribió
$("btnCalibrarDesdeCatalogo").addEventListener("click", () => {
  $("catDetalle").close();
  if (estado.pin) return abrirCalibrar(estado.catActual);
  estado.calibrarDespues = estado.catActual;
  mostrarPantalla("pantallaMantenimiento");
  mostrarAviso("Escriba el PIN del encargado para registrar la calibración");
});

$("btnCerrarDetalle").addEventListener("click", () => $("catDetalle").close());
// Tocar fuera del panel también lo cierra
$("catDetalle").addEventListener("click", (e) => { if (e.target === $("catDetalle")) $("catDetalle").close(); });

// "Prestar este instrumento": va al escáner con el instrumento ya elegido
$("btnPrestarDesdeCatalogo").addEventListener("click", () => {
  estado.instrumentoPreferido = estado.catActual;
  $("catDetalle").close();
  estado.modo = "prestar";
  aplicarModo();
  reiniciarPrestamo();
  $("preseleccionTexto").textContent = `Instrumento elegido: ${estado.catActual.instrumento}`;
  $("preseleccion").hidden = false;
  mostrarPantalla("pantallaPrestamo");
});

function quitarPreseleccion() {
  estado.instrumentoPreferido = null;
  $("preseleccion").hidden = true;
}
$("btnQuitarPreseleccion").addEventListener("click", quitarPreseleccion);

/* ---------------------------------------------------------
   8b. Calibración e incidencias
   --------------------------------------------------------- */

// Acepta 2026-11-08 o 08/11/2026 (por si alguien escribe la fecha a mano en la hoja)
function fechaISO(v) {
  const s = String(v || "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
}

const hoyISO = () => new Date().toLocaleDateString("en-CA");   // yyyy-mm-dd en la hora del iPad
const fechaCorta = (iso) => new Date(`${iso}T12:00`).toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
const diasHasta = (iso) => Math.round((new Date(`${iso}T12:00`) - new Date(`${hoyISO()}T12:00`)) / 864e5);

// Suma meses sin pasarse de fin de mes: 31 ene + 1 mes = 28 feb (igual que el servidor)
function sumarMeses(iso, meses) {
  const [a, m, d] = iso.split("-").map(Number);
  const f = new Date(a, m - 1 + meses, 1, 12);
  f.setDate(Math.min(d, new Date(f.getFullYear(), f.getMonth() + 1, 0).getDate()));
  return f.toLocaleDateString("en-CA");
}

// Estado de calibración según la calibración más reciente: vigente, porVencer, vencida o sin
function calibracion(item) {
  const ultima = estado.calibraciones
    .filter((c) => c.clave === item.clave && fechaISO(c.fecha) && fechaISO(c.proxima))
    .sort((a, b) => fechaISO(b.fecha).localeCompare(fechaISO(a.fecha)))[0];
  if (!ultima) return { nivel: "sin", texto: "Sin registro de calibración", ultima: null };
  const proxima = fechaISO(ultima.proxima), dias = diasHasta(proxima);
  if (dias < 0) return { nivel: "vencida", texto: `Calibración vencida desde el ${fechaCorta(proxima)}`, ultima, proxima, dias };
  if (dias <= DIAS_AVISO) return { nivel: "porVencer", texto: dias === 0 ? "Calibración vence hoy" : `Calibración vence en ${plural(dias, "día", "días")}`, ultima, proxima, dias };
  return { nivel: "vigente", texto: `Calibración vigente hasta el ${fechaCorta(proxima)}`, ultima, proxima, dias };
}

// Incidencias sin resolver de un instrumento (Abierta o En calibración)
const incidenciasDe = (item) => estado.incidencias.filter((i) => i.estado !== "Resuelta"
  && (i.clave ? i.clave === item.clave : mismoNombre(i.instrumento, item.instrumento)));

/* ---------------------------------------------------------
   8c. Pestaña Mantenimiento (solo el encargado, con PIN)
   --------------------------------------------------------- */

// El PIN se recuerda mientras Safari tenga abierta la pestaña (se borra al cerrarla)
try { estado.pin = sessionStorage.getItem("managerlab.pin"); } catch (e) { /* sin almacenamiento */ }

// Para entrar se necesitan el PIN y el nombre de quien revisa (queda en cada aprobación)
function aplicarAccesoMant() {
  const dentro = Boolean(estado.pin && encargadoGuardado());
  $("formPin").hidden = dentro;
  $("mantContenido").hidden = !dentro;
  $("btnSalirMant").hidden = !dentro;
  if (dentro) pintarMantenimiento();
  else {
    $("mantResumen").textContent = "";
    prepararEncargado("campoEncargado");
    setTimeout(() => $($("campoEncargado").value ? "campoPin" : "campoEncargado").focus(), 50);
  }
}

$("formPin").addEventListener("submit", async (e) => {
  e.preventDefault();
  const pin = $("campoPin").value.trim();
  const error = $("errorPin");
  const nombre = $("campoEncargado").value.trim();
  if (nombre.length < 3) { error.textContent = "Escriba su nombre: queda registrado en cada revisión."; error.hidden = false; $("campoEncargado").focus(); return; }
  if (!/^\d{4,8}$/.test(pin)) { error.textContent = "El PIN es de 4 a 8 dígitos."; error.hidden = false; return; }
  const boton = $("btnPin");
  boton.disabled = true;
  try {
    const respuesta = await enviarApi({ accion: "pin", pin });
    if (!respuesta.ok) throw new Error(respuesta.error || "PIN incorrecto");
    estado.pin = pin;
    guardarEncargado(nombre);
    try { sessionStorage.setItem("managerlab.pin", pin); } catch (err) { /* sin almacenamiento */ }
    error.hidden = true;
    $("campoPin").value = "";
    aplicarAccesoMant();
    if (estado.calibrarDespues) { abrirCalibrar(estado.calibrarDespues); estado.calibrarDespues = null; }
  } catch (err) {
    if (err instanceof TypeError) marcarConexion(false);
    error.textContent = err instanceof TypeError ? "No se pudo conectar con el servidor." : err.message;
    error.hidden = false;
  } finally {
    boton.disabled = false;
  }
});
$("campoPin").addEventListener("input", (e) => (e.target.value = e.target.value.replace(/\D/g, "")));

function salirMant() {
  estado.pin = null;
  try { sessionStorage.removeItem("managerlab.pin"); } catch (e) { /* sin almacenamiento */ }
  aplicarAccesoMant();
}
$("btnSalirMant").addEventListener("click", salirMant);

const HORAS_REVISION = 4;   // una devolución sin revisar por más tiempo se marca en ámbar
const porRevisar = () => (estado.prestamos || []).filter((p) => p.estado === "Por revisar");

// Número rojo en la pestaña: devoluciones por revisar + incidencias sin resolver + calibraciones vencidas
function pintarContadorMant() {
  const n = porRevisar().length + estado.incidencias.filter((i) => i.estado !== "Resuelta").length
    + estado.catalogo.filter((c) => calibracion(c).nivel === "vencida").length;
  $("mantContador").textContent = n;
  $("mantContador").hidden = !n;
}

// Fila de las listas de mantenimiento
function crearFilaMant(titulo, detalle, extra, insignia, botones) {
  const fila = crear("div", "pendiente grande mant-fila");
  fila.setAttribute("role", "listitem");
  const info = crear("div", "pendiente-info");
  info.append(crear("strong", "", titulo), crear("span", "pendiente-detalle", detalle));
  if (extra) info.append(crear("span", "mant-extra", extra));
  const lado = crear("div", "mant-lado");
  if (insignia) lado.append(crear("span", "insignia-estado " + insignia[0], insignia[1]));
  botones.forEach(([textoBoton, icono, alTocar, clase]) => {
    const boton = crear("button", "btn pendiente-btn " + (clase || "btn-secundario"));
    boton.type = "button";
    boton.innerHTML = `<i data-lucide="${icono}" aria-hidden="true"></i>`;
    boton.append(crear("span", "", textoBoton));
    boton.setAttribute("aria-label", `${textoBoton}: ${titulo}`);
    boton.addEventListener("click", () => alTocar(boton));
    lado.append(boton);
  });
  fila.append(info, lado);
  return fila;
}

function pintarLista(id, filas, vacio) {
  const caja = $(id);
  caja.innerHTML = "";
  if (!filas.length) caja.append(crear("p", "vacio-pendientes", vacio));
  filas.forEach((f) => caja.append(f));
}

function pintarMantenimiento() {
  const abiertas = estado.incidencias.filter((i) => i.estado !== "Resuelta")
    .sort((a, b) => (fechaISO(a.fecha) + a.hora).localeCompare(fechaISO(b.fecha) + b.hora));
  const conCal = estado.catalogo.map((item) => ({ item, cal: calibracion(item) }));
  const vencidas = conCal.filter((x) => x.cal.nivel === "vencida").sort((a, b) => a.cal.dias - b.cal.dias);
  const porVencer = conCal.filter((x) => x.cal.nivel === "porVencer").sort((a, b) => a.cal.dias - b.cal.dias);
  const revisar = porRevisar();
  $("mantResumen").textContent = `Revisa: ${encargadoGuardado()} · ${plural(revisar.length, "devolución por revisar", "devoluciones por revisar")} · ${plural(abiertas.length, "incidencia sin resolver", "incidencias sin resolver")} · ${plural(vencidas.length, "calibración vencida", "calibraciones vencidas")} · ${porVencer.length} por vencer`;

  pintarRevisiones(revisar);

  pintarLista("mantIncidencias", abiertas.map((i) => {
    const item = estado.catalogo.find((c) => (i.clave ? c.clave === i.clave : mismoNombre(c.instrumento, i.instrumento)));
    const enCal = i.estado === "En calibración";
    return crearFilaMant(`${i.piezas || 1} × ${i.instrumento}`,
      `${i.id} · ${i.condicion} · ${fechaISO(i.fecha)} · devolvió ${i.nombre} (${i.area}) · préstamo ${i.folio}`,
      i.observacion, enCal ? ["prestado", "Esperando calibración"] : ["abierta", "Abierta"],
      [[enCal ? "Registrar calibración" : "Resolver", "wrench", () => (enCal && item ? abrirCalibrar(item) : abrirResolver(i))]]);
  }), "No hay instrumentos dañados ni incompletos.");

  const filaCal = ({ item, cal }) => crearFilaMant(item.instrumento,
    `${item.clave} · ${cal.nivel === "vencida" ? "venció" : "vence"} el ${fechaCorta(cal.proxima)} · certificado ${cal.ultima.certificado || "—"}`,
    "", cal.nivel === "vencida" ? ["abierta", `Hace ${plural(-cal.dias, "día", "días")}`] : ["prestado", `En ${plural(cal.dias, "día", "días")}`],
    [["Registrar calibración", "wrench", () => abrirCalibrar(item)]]);
  pintarLista("mantVencidas", vencidas.map(filaCal), "Ningún instrumento tiene la calibración vencida.");
  pintarLista("mantPorVencer", porVencer.map(filaCal), `Ninguna calibración vence en los próximos ${DIAS_AVISO} días.`);
  pintarIconos();
}

/* ----- Devoluciones por revisar: el encargado confirma el estado real ----- */
const horasDesde = (p) => (Date.now() - new Date(`${fechaISO(p.fecha_devolucion)}T${p.hora_devolucion || "00:00"}:00`)) / 3600000;

function pintarRevisiones(lista) {
  const caja = $("mantRevisar");
  caja.innerHTML = "";
  if (!lista.length) { caja.append(crear("p", "vacio-pendientes", "No hay devoluciones esperando revisión.")); return; }
  // Agrupadas por trabajador, la más antigua primero
  const grupos = new Map();
  lista.slice().sort((a, b) => (fechaISO(a.fecha_devolucion) + a.hora_devolucion).localeCompare(fechaISO(b.fecha_devolucion) + b.hora_devolucion))
    .forEach((p) => grupos.set(p.matricula, [...(grupos.get(p.matricula) || []), p]));
  grupos.forEach((prestamos) => {
    const cabeza = crear("div", "mant-trabajador");
    cabeza.append(crear("strong", "", `${prestamos[0].nombre} · ${prestamos[0].area}`));
    if (prestamos.length > 1) {
      const todas = crear("button", "btn btn-secundario pendiente-btn");
      todas.type = "button";
      todas.innerHTML = '<i data-lucide="check-check" aria-hidden="true"></i>';
      todas.append(crear("span", "", `Aprobar todas (${prestamos.length})`));
      todas.addEventListener("click", () => aprobarTodas(prestamos, todas));
      cabeza.append(todas);
    }
    caja.append(cabeza);
    prestamos.forEach((p) => {
      const [dijo, ...resto] = String(p.declaracion || "Bien").split(":");
      const comentario = resto.join(":").trim();
      const horas = horasDesde(p);
      const tarde = horas > HORAS_REVISION;
      const fila = crearFilaMant(`${p.cantidad} × ${p.instrumento}`,
        `${p.folio} · devuelto ${fechaCorta(fechaISO(p.fecha_devolucion))} ${p.hora_devolucion} h${tarde ? ` · hace ${Math.floor(horas)} h sin revisar` : ""}`,
        comentario ? `Comentario: ${comentario}` : "",
        [dijo.trim() === "Bien" ? "devuelto" : "abierta", `Dijo: ${dijo.trim()}`],
        [["Está bien", "circle-check", (b) => aprobar(p, b), "btn-principal"], ["Tiene un problema", "triangle-alert", () => abrirRevisar(p)]]);
      if (tarde) fila.classList.add("tarde");
      caja.append(fila);
    });
  });
}

// Guarda la revisión y actualiza la pantalla sin recargar
async function enviarRevision(p, datos, boton, error) {
  const r = await enviarMant({ accion: "revisar_devolucion", folio: p.folio, ...datos }, boton, error);
  if (!r) return null;
  Object.assign(p, { estado: "Devuelto", condicion: datos.condicion, observaciones: datos.observacion || "", reviso: datos.reviso,
                     fecha_revision: r.fecha_revision, hora_revision: r.hora_revision, discrepancia: r.discrepancia });
  if (r.incidencia) estado.incidencias.push({
    id: r.incidencia, fecha: r.fecha_revision, hora: r.hora_revision, folio: p.folio,
    clave: estado.catalogo.find((i) => mismoNombre(i.instrumento, p.instrumento))?.clave || "", instrumento: p.instrumento,
    piezas: String(datos.piezas || 1), matricula: p.matricula, nombre: p.nombre, area: p.area,
    condicion: datos.condicion, observacion: datos.observacion, estado: r.estado_incidencia || "Abierta"
  });
  return r;
}

const encargadoGuardado = () => { try { return localStorage.getItem(ENCARGADO) || ""; } catch (e) { return ""; } };

async function aprobar(p, boton) {
  const r = await enviarRevision(p, { condicion: "Bien", reviso: encargadoGuardado() }, boton, $("errorRevisar"));
  if (!r) return;
  mostrarAviso(`${p.folio} aprobado · ${p.instrumento} disponible`);
  pintarTodo();
}

async function aprobarTodas(lista, boton) {
  if (!confirm(`¿Aprobar las ${lista.length} devoluciones de ${lista[0].nombre} como «Bien»? Hágalo solo si ya revisó todos los instrumentos.`)) return;
  let hechas = 0;
  for (const p of lista) {
    if (!(await enviarRevision(p, { condicion: "Bien", reviso: encargadoGuardado() }, boton, $("errorRevisar")))) break;
    hechas++;
  }
  if (hechas) mostrarAviso(plural(hechas, "devolución aprobada", "devoluciones aprobadas"));
  pintarTodo();
}

function abrirRevisar(p) {
  estado.mantActual = p;
  $("formRevisar").reset();
  const [dijo, ...resto] = String(p.declaracion || "Bien").split(":");
  // Si el trabajador ya reportó el problema, se propone lo que dijo
  if (dijo.trim() === "Incompleto") $("formRevisar").elements.condicionRev.value = "Incompleto";
  $("campoProblema").value = resto.join(":").trim();
  const piezas = $("campoPiezasRev");
  piezas.innerHTML = "";
  for (let n = 1; n <= p.cantidad; n++) piezas.add(new Option(`${n} de ${p.cantidad}`, n));
  $("grupoPiezasRev").hidden = p.cantidad <= 1;
  prepararEncargado("campoReviso");
  abrirDialogoMant(`${p.folio} · ${p.nombre}`, `${p.cantidad} × ${p.instrumento}`, `El trabajador declaró: ${p.declaracion || "Bien"}`, "formRevisar");
}

$("formRevisar").addEventListener("submit", async (e) => {
  e.preventDefault();
  const p = estado.mantActual;
  const observacion = $("campoProblema").value.trim();
  if (!observacion) { $("errorRevisar").textContent = "Describa qué le encontró al instrumento."; $("errorRevisar").hidden = false; $("campoProblema").focus(); return; }
  const reviso = $("campoReviso").value.trim();
  if (!reviso) { $("errorRevisar").textContent = "Escriba el nombre del encargado que revisa."; $("errorRevisar").hidden = false; $("campoReviso").focus(); return; }
  guardarEncargado(reviso);
  const datos = { condicion: $("formRevisar").elements.condicionRev.value, observacion, piezas: Number($("campoPiezasRev").value) || 1,
                  requiere_calibracion: $("campoReqCal").checked, reviso };
  const r = await enviarRevision(p, datos, $("btnRevisar"), $("errorRevisar"));
  if (!r) return;
  $("mantDialogo").close();
  mostrarAviso(`${r.incidencia} abierta · ${p.instrumento}` + (r.discrepancia === "Sí" ? " · discrepancia registrada" : ""));
  pintarTodo();
});

// El nombre del encargado se recuerda en este iPad para no escribirlo cada vez
const ENCARGADO = "managerlab.encargado";
function prepararEncargado(id) {
  try { $(id).value = localStorage.getItem(ENCARGADO) || ""; } catch (e) { /* sin almacenamiento */ }
}
function guardarEncargado(valor) {
  try { localStorage.setItem(ENCARGADO, valor); } catch (e) { /* sin almacenamiento */ }
}

function abrirDialogoMant(meta, titulo, descripcion, formulario) {
  $("mantMeta").textContent = meta;
  $("mantTitulo").textContent = titulo;
  $("mantDescripcion").textContent = descripcion;
  $("mantDescripcion").hidden = !descripcion;
  $("formResolver").hidden = formulario !== "formResolver";
  $("formCalibrar").hidden = formulario !== "formCalibrar";
  $("formRevisar").hidden = formulario !== "formRevisar";
  document.querySelectorAll("#mantDialogo .alerta-error").forEach((e) => (e.hidden = true));
  $("mantDialogo").showModal();
}

function abrirResolver(inc) {
  estado.mantActual = inc;
  $("formResolver").reset();
  prepararEncargado("campoResolvio");
  abrirDialogoMant(`${inc.id} · ${inc.condicion}`, `${inc.piezas || 1} × ${inc.instrumento}`, inc.observacion, "formResolver");
}

function abrirCalibrar(item) {
  estado.mantActual = item;
  $("formCalibrar").reset();
  const hoy = hoyISO();
  Object.assign($("campoFechaCal"), { value: hoy, max: hoy });
  // Sugiere quién calibró la última vez y los laboratorios ya usados
  const cal = calibracion(item);
  $("campoCalibro").value = cal.ultima?.calibro || "";
  $("listaCalibro").innerHTML = "";
  [...new Set(estado.calibraciones.map((c) => c.calibro).filter(Boolean))].forEach((v) => $("listaCalibro").append(new Option(v)));
  prepararEncargado("campoRegistro");
  actualizarProxima();
  abrirDialogoMant(`${item.clave} · cada ${item.frecuencia_meses || 12} meses`, item.instrumento, cal.texto, "formCalibrar");
}

function actualizarProxima() {
  const fecha = $("campoFechaCal").value, meses = parseInt(estado.mantActual?.frecuencia_meses, 10) || 12;
  $("proximaCal").textContent = fecha ? `Próxima calibración: ${fechaCorta(sumarMeses(fecha, meses))}` : "";
}
$("campoFechaCal").addEventListener("input", actualizarProxima);

$("btnCerrarMant").addEventListener("click", () => $("mantDialogo").close());
$("mantDialogo").addEventListener("click", (e) => { if (e.target === $("mantDialogo")) $("mantDialogo").close(); });

// Envía una acción del encargado. Si el PIN ya no es válido, vuelve a pedirlo.
async function enviarMant(cuerpo, boton, error) {
  boton.disabled = true;
  error.hidden = true;
  try {
    const respuesta = await enviarApi({ ...cuerpo, pin: estado.pin });
    if (!respuesta.ok) {
      if (respuesta.error === "PIN incorrecto") { $("mantDialogo").close(); salirMant(); }
      throw new Error(respuesta.error || "La API rechazó el registro.");
    }
    return respuesta;
  } catch (err) {
    if (err instanceof TypeError) marcarConexion(false);
    error.textContent = err instanceof TypeError ? "No se pudo conectar con el servidor. Intente de nuevo." : `No se guardó: ${err.message}`;
    error.hidden = false;
    if (!$("mantDialogo").open) mostrarAviso(error.textContent);
    return null;
  } finally {
    boton.disabled = false;
  }
}

$("formResolver").addEventListener("submit", async (e) => {
  e.preventDefault();
  const inc = estado.mantActual;
  const resolucion = $("formResolver").elements.resolucion.value;
  const resolvio = $("campoResolvio").value.trim();
  guardarEncargado(resolvio);
  const r = await enviarMant({ accion: "resolver_incidencia", id: inc.id, resolucion, nota: $("campoNota").value.trim(), resolvio },
    $("btnResolver"), $("errorResolver"));
  if (!r) return;
  Object.assign(inc, { estado: r.estado, resolucion, fecha_resolucion: r.fecha_resolucion });
  const item = estado.catalogo.find((c) => c.clave === inc.clave);
  if (item && r.existencias != null) item.existencias = String(r.existencias);
  $("mantDialogo").close();
  mostrarAviso(resolucion === "Reparado" ? `${inc.instrumento} vuelve a estar disponible`
    : resolucion === "Baja" ? `${inc.instrumento} dado de baja` : `${inc.instrumento} queda esperando calibración`);
  pintarTodo();
});

$("formCalibrar").addEventListener("submit", async (e) => {
  e.preventDefault();
  const item = estado.mantActual;
  const fecha = $("campoFechaCal").value, certificado = $("campoCertificado").value.trim();
  if (!fecha || fecha > hoyISO()) { $("errorCalibrar").textContent = "Elija una fecha de hoy o anterior."; $("errorCalibrar").hidden = false; return; }
  if (!certificado) { $("errorCalibrar").textContent = "Escriba el número de certificado."; $("errorCalibrar").hidden = false; $("campoCertificado").focus(); return; }
  const registro = $("campoRegistro").value.trim();
  guardarEncargado(registro);
  const cuerpo = { accion: "calibracion", clave_instrumento: item.clave, fecha, certificado, calibro: $("campoCalibro").value.trim(), registro };
  const r = await enviarMant(cuerpo, $("btnCalibrar"), $("errorCalibrar"));
  if (!r) return;
  estado.calibraciones.push({ fecha: r.fecha, clave: item.clave, instrumento: item.instrumento, certificado, calibro: cuerpo.calibro, proxima: r.proxima, registro });
  incidenciasDe(item).filter((i) => i.estado === "En calibración").forEach((i) => (i.estado = "Resuelta"));
  $("mantDialogo").close();
  mostrarAviso(`Calibración registrada · próxima el ${fechaCorta(r.proxima)}`);
  pintarTodo();
});

/* ---------------------------------------------------------
   9. Generar credencial
   --------------------------------------------------------- */

// Llena las listas de área y jefe con los datos de la API
function pintarListasAreas() {
  const area = $("campoArea"), jefe = $("campoJefe");
  area.innerHTML = '<option value="">Elija un área</option>';
  jefe.innerHTML = '<option value="">Elija un jefe</option>';
  estado.areas.forEach((a) => area.add(new Option(a.area, a.area)));
  [...new Set(estado.areas.map((a) => a.jefe))].forEach((j) => jefe.add(new Option(j, j)));
}

// Reglas de validación de cada campo: devuelven el mensaje de error o "" si está bien
const reglas = {
  campoMatricula: (v) => !v ? "Escriba la matrícula." : !/^\d{5,8}$/.test(v) ? `Debe tener de 5 a 8 dígitos (lleva ${v.length}).` : "",
  campoNombre: (v) => !v ? "Escriba el nombre completo." : v.split(/\s+/).length < 2 ? "Incluya nombre y al menos un apellido." : "",
  campoArea: (v) => (v ? "" : "Elija el área del trabajador."),
  campoJefe: (v) => (v ? "" : "Elija el jefe de área.")
};
const mensajesAyuda = {
  campoMatricula: "De 5 a 8 dígitos.",
  campoNombre: "Nombre y apellidos, máximo 60 caracteres.",
  campoArea: "Al elegir el área se propone su jefe.",
  campoJefe: ""
};

// Valida un campo y muestra su mensaje debajo. "mostrarError" evita marcar en rojo antes de tiempo.
function validarCampo(id, mostrarError) {
  const campo = $(id);
  const valor = campo.value.trim().replace(/\s+/g, " ");
  const error = reglas[id](valor);
  const msg = $("msg" + id.replace("campo", ""));
  campo.classList.toggle("invalido", Boolean(error) && mostrarError);
  campo.classList.toggle("valido", !error);
  campo.setAttribute("aria-invalid", String(Boolean(error) && mostrarError));
  msg.className = "msg-campo" + (error && mostrarError ? " error" : !error ? " ok" : "");
  msg.textContent = error && mostrarError ? error : !error && id === "campoMatricula" ? "Matrícula válida." : mensajesAyuda[id];
  return !error;
}

$("campoMatricula").addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/\D/g, "");
  validarCampo("campoMatricula", e.target.value.length >= 5);
});
$("campoNombre").addEventListener("input", () => validarCampo("campoNombre", false));
["campoMatricula", "campoNombre"].forEach((id) => $(id).addEventListener("blur", () => validarCampo(id, true)));
$("campoArea").addEventListener("change", () => {
  const encontrada = estado.areas.find((a) => a.area === $("campoArea").value);
  if (encontrada) $("campoJefe").value = encontrada.jefe;   // propone el jefe del área
  validarCampo("campoArea", true);
  validarCampo("campoJefe", Boolean($("campoArea").value));
});
$("campoJefe").addEventListener("change", () => validarCampo("campoJefe", true));

$("formCredencial").addEventListener("submit", guardarTrabajador);

async function guardarTrabajador(e) {
  e.preventDefault();
  const ids = Object.keys(reglas);
  const todosValidos = ids.map((id) => validarCampo(id, true)).every(Boolean);
  if (!todosValidos) { $(ids.find((id) => $(id).classList.contains("invalido"))).focus(); return; }

  const trabajador = {
    matricula: $("campoMatricula").value.trim(),
    nombre: $("campoNombre").value.trim().replace(/\s+/g, " "),
    area: $("campoArea").value,
    jefe: $("campoJefe").value
  };
  const boton = $("btnGuardarTrabajador");
  boton.disabled = true;
  boton.querySelector("span").textContent = "Guardando...";
  $("errorCredencial").hidden = true;

  try {
    const respuesta = await enviarApi({ accion: "personal", ...trabajador });
    if (!respuesta.ok) throw new Error(respuesta.error || "La API rechazó el registro.");
    const guardado = { ...trabajador, ...(respuesta.trabajador || {}) };
    estado.personal.push(guardado);
    try {
      generarCredencial(guardado);
      mostrarAviso("Trabajador guardado y credencial generada");
    } catch (errorQR) {
      $("errorCredencial").textContent = `El trabajador se guardó, pero no se pudo generar el QR: ${errorQR.message}`;
      $("errorCredencial").hidden = false;
    }
  } catch (error) {
    if (error instanceof TypeError) marcarConexion(false);   // falla de red
    $("errorCredencial").textContent = error instanceof TypeError
      ? "No se pudo conectar con el servidor. Revise la conexión e intente de nuevo."
      : `No se guardó el trabajador: ${error.message}`;
    $("errorCredencial").hidden = false;
  } finally {
    boton.disabled = false;
    boton.querySelector("span").textContent = "Guardar y generar credencial";
  }
}

// qrcode.js 1.0.0 calcula mal el tamaño cuando hay acentos o ñ ("code length overflow").
// Por eso los caracteres no ASCII se escriben como é: JSON.parse los recupera igual.
function textoParaQR(datos) {
  return JSON.stringify(datos).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

// Llena la credencial y genera el QR con nivel de corrección H
function generarCredencial(t) {
  $("credNombre").textContent = t.nombre;
  $("credMatricula").textContent = t.matricula;
  $("credArea").textContent = t.area;
  $("credJefe").textContent = t.jefe;

  const contenedorQR = $("credQR");
  contenedorQR.innerHTML = "";
  if (!window.QRCode) { contenedorQR.textContent = "Sin QR"; mostrarAviso("No se pudo cargar qrcode.js"); return; }
  new QRCode(contenedorQR, {
    text: textoParaQR({ m: String(t.matricula), n: t.nombre, a: t.area, j: t.jefe }),
    width: 512, height: 512,
    colorDark: "#1A2330", colorLight: "#FFFFFF",
    correctLevel: QRCode.CorrectLevel.H
  });
  estado.credencialLista = true;
  $("btnImprimir").disabled = false;
  $("btnDescargar").disabled = false;
}

$("btnImprimir").addEventListener("click", () => window.print());
$("btnDescargar").addEventListener("click", descargarCredencial);

// Dibuja la credencial en un canvas a 300 dpi (1011 × 638 px) y la descarga como PNG
function descargarCredencial() {
  const ancho = 1011, alto = 638, mm = ancho / 85.6;
  const lienzo = document.createElement("canvas");
  lienzo.width = ancho; lienzo.height = alto;
  const c = lienzo.getContext("2d");
  const fuente = (peso, tam) => `${peso} ${tam}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const cortar = (texto, max) => { while (c.measureText(texto).width > max && texto.length > 3) texto = texto.slice(0, -2) + "…"; return texto; };

  // Fondo y franja superior
  c.fillStyle = "#FFFFFF"; c.fillRect(0, 0, ancho, alto);
  const franja = c.createLinearGradient(0, 0, ancho, 0);
  franja.addColorStop(0, "#0077B3"); franja.addColorStop(1, "#0095D8");
  c.fillStyle = franja; c.fillRect(0, 0, ancho, 9 * mm);
  c.fillStyle = "#FFFFFF"; c.font = fuente(700, 3 * mm); c.textBaseline = "middle";
  c.fillText("ManagerLAB · Laboratorio de Metrología", 4 * mm, 4.5 * mm);

  // Datos del trabajador (izquierda)
  const x = 4 * mm, maxTexto = 44 * mm;
  c.textBaseline = "alphabetic";
  c.fillStyle = "#1A2330"; c.font = fuente(800, 4.2 * mm);
  c.fillText(cortar($("credNombre").textContent, maxTexto), x, 16 * mm);
  const filas = [["MATRÍCULA", $("credMatricula").textContent, 4.4, 22], ["ÁREA", $("credArea").textContent, 2.8, 32], ["JEFE", $("credJefe").textContent, 2.8, 40]];
  filas.forEach(([etiqueta, valor, tam, y]) => {
    c.fillStyle = "#5F6B7A"; c.font = fuente(700, 2 * mm); c.fillText(etiqueta, x, y * mm);
    c.fillStyle = "#1A2330"; c.font = fuente(tam > 3 ? 800 : 600, tam * mm); c.fillText(cortar(valor, maxTexto), x, (y + tam + 0.6) * mm);
  });

  // QR (derecha) con margen blanco
  const lado = 28 * mm, qx = ancho - 4 * mm - lado, qy = 11 * mm;
  const origen = $("credQR").querySelector("canvas");
  if (origen) { c.imageSmoothingEnabled = false; c.drawImage(origen, qx, qy, lado, lado); }

  // Pie
  c.strokeStyle = "rgba(138,151,166,.35)"; c.lineWidth = 2;
  c.beginPath(); c.moveTo(0, alto - 6 * mm); c.lineTo(ancho, alto - 6 * mm); c.stroke();
  c.fillStyle = "#5F6B7A"; c.font = fuente(500, 2 * mm); c.textBaseline = "middle";
  c.fillText("Prototipo académico ManagerLAB", 4 * mm, alto - 3 * mm);

  const enlace = document.createElement("a");
  enlace.download = `credencial_${$("credMatricula").textContent}.png`;
  enlace.href = lienzo.toDataURL("image/png");
  enlace.click();
}

/* ---------------------------------------------------------
   10. Utilidades
   --------------------------------------------------------- */

// Convierte los <i data-lucide> en íconos SVG
function pintarIconos() {
  if (window.lucide) lucide.createIcons();
}

function mostrarAviso(texto) {
  const aviso = $("avisoFlotante");
  aviso.textContent = texto;
  aviso.classList.add("visible");
  clearTimeout(aviso._t);
  aviso._t = setTimeout(() => aviso.classList.remove("visible"), 2800);
}

// Autocomprobación rápida del lector de credenciales (aparece en la consola si falla)
console.assert(leerCredencial('{"m":"104523","n":"Laura Méndez Ortiz","a":"Metrología","j":"Ing. Carlos Ruiz"}')?.matricula === "104523", "QR válido");
console.assert(leerCredencial('﻿{"m":"104523","n":"Ana López","a":"A","j":"J"}') !== null, "QR con BOM");
console.assert(leerCredencial('{"m":"12","n":"Ana","a":"A","j":"J"}') === null, "matrícula corta");
console.assert(leerCredencial("https://ejemplo.com") === null, "texto que no es JSON");
console.assert(mismaMatricula("097815", "97815") && !mismaMatricula("104523", "104524"), "matrículas con ceros");
console.assert(tiempoFuera({ fecha: "2000-01-01", hora: "08:00" }).vencido === true, "préstamo vencido");
console.assert(formatearDuracion(75.2) === "1:15.2" && formatearDuracion(9.5) === "0:09.5", "formato del cronómetro");
console.assert(disponibilidad({ instrumento: "Prueba", existencias: "2" }).nivel === "libre" && disponibilidad({ instrumento: "Prueba" }).texto === "Disponible", "disponibilidad sin préstamos");
console.assert(fechaISO("08/11/2026") === "2026-11-08" && fechaISO("2026-1-5") === "2026-01-05" && fechaISO("ayer") === "", "fechas de la hoja");
console.assert(sumarMeses("2026-01-31", 1) === "2026-02-28" && sumarMeses("2026-11-08", 12) === "2027-11-08", "próxima calibración");
console.assert(calibracion({ clave: "X" }).nivel === "sin" && diasHasta(hoyISO()) === 0, "calibración sin registro");
console.assert(leerCredencial(textoParaQR({ m: "104523", n: "Begoña Núñez", a: "Metrología", j: "Ing. Raúl" }))?.nombre === "Begoña Núñez", "acentos en el QR");

/* ---------------------------------------------------------
   Arranque
   --------------------------------------------------------- */
pintarIconos();
actualizarProgreso();
cargarDatosIniciales();
iniciarCamara();
