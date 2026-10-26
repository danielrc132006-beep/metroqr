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
  credencialLista: false
};

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

  if (catalogo.status === "fulfilled") { estado.catalogo = catalogo.value; pintarCatalogo(); }
  else $("catalogo").innerHTML = '<p class="cargando">No se pudo cargar el catálogo. Revise la conexión y recargue la página.</p>';

  if (areas.status === "fulfilled") { estado.areas = areas.value; pintarListasAreas(); }
  if (personal.status === "fulfilled") estado.personal = personal.value;
}

// Revisa la conexión cada minuto
setInterval(() => consultarApi("areas").catch(() => marcarConexion(false)), 60000);
window.addEventListener("offline", () => marcarConexion(false));

/* ---------------------------------------------------------
   2. Navegación entre pestañas y pasos
   --------------------------------------------------------- */

document.querySelectorAll(".pestana").forEach((boton) => {
  boton.addEventListener("click", () => mostrarPantalla(boton.dataset.pantalla));
});

function mostrarPantalla(idPantalla) {
  document.querySelectorAll(".pestana").forEach((b) => b.setAttribute("aria-selected", b.dataset.pantalla === idPantalla));
  document.querySelectorAll(".pantalla").forEach((p) => (p.hidden = p.id !== idPantalla));
  // La cámara solo se usa en el paso 1 del préstamo
  if (idPantalla === "pantallaPrestamo" && !$("paso1").hidden) iniciarCamara();
  else detenerCamara();
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
  $("errorPrestamo").hidden = true;
  irAPaso(2);
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
function cantidadMaxima() {
  return /cantidad 1\b/i.test(estado.instrumento?.notas || "") ? 1 : CANTIDAD_MAX;
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
  const boton = $("btnRegistrar");
  boton.disabled = true;
  boton.querySelector("span").textContent = "Guardando...";
  $("errorPrestamo").hidden = true;

  try {
    const respuesta = await enviarApi({
      accion: "prestamo",
      matricula: estado.trabajador.matricula,
      instrumento: estado.instrumento.instrumento,
      cantidad: estado.cantidad
    });
    if (respuesta.ok) mostrarExito(respuesta);
    else mostrarErrorPrestamo(respuesta.error || "La API rechazó el préstamo.");
  } catch (error) {
    marcarConexion(false);
    mostrarErrorPrestamo("No se pudo conectar con el servidor. Revise la conexión e intente de nuevo.");
  } finally {
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
function mostrarExito(respuesta) {
  const t = respuesta.trabajador || estado.trabajador;
  $("exitoFolio").textContent = respuesta.folio;
  $("exitoResumen").textContent =
    `${estado.cantidad} × ${estado.instrumento.instrumento} para ${t.nombre} (${t.matricula}) · ${respuesta.fecha} a las ${respuesta.hora} h`;
  irAPaso("exito");
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
  estado.trabajador = null;
  estado.instrumento = null;
  estado.cantidad = CANTIDAD_MIN;
  $("tiempoLectura").textContent = "";
  irAPaso(1);
}
$("btnNuevoPrestamo").addEventListener("click", reiniciarPrestamo);

/* ---------------------------------------------------------
   7. Generar credencial
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
   8. Utilidades
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
console.assert(leerCredencial(textoParaQR({ m: "104523", n: "Begoña Núñez", a: "Metrología", j: "Ing. Raúl" }))?.nombre === "Begoña Núñez", "acentos en el QR");

/* ---------------------------------------------------------
   Arranque
   --------------------------------------------------------- */
pintarIconos();
actualizarProgreso();
cargarDatosIniciales();
iniciarCamara();
