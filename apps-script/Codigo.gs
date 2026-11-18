/**
 * MetroQR · ManagerLAB
 * API de Google Apps Script para la hoja ManagerLAB_BaseDatos.
 *
 * Pegar en: Extensiones → Apps Script (reemplazar todo el contenido de Código.gs).
 * Pestañas requeridas (nombres exactos): Personal, Prestamos, Catalogo, Areas, Calibraciones, Incidencias, Encargados.
 * Personal lleva además: activo (Sí / No).
 * Encargados: nombre, pin_nuevo, pin_hash, activo. Para dar o cambiar un PIN se escribe en pin_nuevo;
 *   al primer acceso correcto la API guarda solo su hash y borra pin_nuevo.
 * Prestamos lleva además: estado, fecha_devolucion, hora_devolucion, recibio, duracion_seg, condicion, observaciones,
 *   declaracion, reviso, fecha_revision, hora_revision, discrepancia.
 *
 * La clave de la API NO va en el código (el repositorio es público): se guarda en
 *   Configuración del proyecto → Propiedades de la secuencia de comandos → CLAVE.
 */

const CLAVE = PropertiesService.getScriptProperties().getProperty('CLAVE') || '';
const MAX_INTENTOS = 5;          // intentos fallidos de PIN antes de bloquear al encargado
const BLOQUEO_SEG = 15 * 60;     // duración del bloqueo
const ZONA = 'America/Mexico_City';
const MAX_CANTIDAD = 10;
// Los textos que la app compara van con \u00f1 (ñ) y \u00f3 (ó): así no se rompen al copiar y pegar el código
const CALIBRACION = 'Calibraci\u00f3n';
const EN_CALIBRACION = 'En calibraci\u00f3n';
const CONDICIONES = ['Bien', 'Da\u00f1ado', 'Incompleto'];
const RESOLUCIONES = ['Reparado', CALIBRACION, 'Baja'];
const POR_REVISAR = 'Por revisar';
const SI = 'S\u00ed';

/* ---------- LECTURA (GET) ----------
 * URL?accion=catalogo&clave=...       → instrumentos
 * URL?accion=personal&clave=...       → trabajadores
 * URL?accion=areas&clave=...          → áreas y jefes
 * URL?accion=prestamos&clave=...      → historial (incluye estado y devolución)
 * URL?accion=calibraciones&clave=...  → historial de calibraciones
 * URL?accion=incidencias&clave=...    → instrumentos dañados o incompletos
 * URL (sin parámetros)                → prueba de que la API funciona
 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.accion) return responder({ ok: true, mensaje: 'API MetroQR activa' });
  if (!CLAVE || p.clave !== CLAVE) return responder({ ok: false, error: 'Clave incorrecta' });

  // Encargados no se expone: solo la usa la API para validar PIN
  const hojas = { personal: 'Personal', catalogo: 'Catalogo', areas: 'Areas', prestamos: 'Prestamos',
                  calibraciones: 'Calibraciones', incidencias: 'Incidencias' };
  const hoja = hojas[p.accion];
  if (!hoja) return responder({ ok: false, error: 'Acción no válida' });
  return responder({ ok: true, datos: leerHoja(hoja) });
}

/* ---------- ESCRITURA (POST) ----------
 * Cuerpo (texto JSON):
 *   { "clave": "...", "accion": "prestamo", "matricula": "104523",
 *     "instrumento": "Calibrador vernier", "cantidad": 2, "duracion": 18.4 }   ← duracion opcional (segundos)
 *   { "clave": "...", "accion": "personal", "matricula": "104523",
 *     "nombre": "...", "area": "...", "jefe": "..." }
 *   { "clave": "...", "accion": "devolucion", "folio": "ML-0003", "recibio": "...",
 *     "condicion": "Bien" | "Dañado" | "Incompleto", "observacion": "..." }   ← queda Por revisar
 * Mantenimiento (llevan además "encargado" y "pin"; el nombre que se guarda es el del encargado validado):
 *   { "accion": "pin", "encargado": "...", "pin": "2468" }            ← solo comprueba el PIN
 *   { "accion": "resolver_incidencia", "id": "INC-0002",
 *     "resolucion": "Reparado" | "Calibración" | "Baja", "nota": "..." }
 *   { "accion": "revisar_devolucion", "folio": "ML-0003", "condicion": "Bien" | "Dañado" | "Incompleto",
 *     "observacion": "...", "piezas": 1, "requiere_calibracion": false }
 *   { "accion": "calibracion", "clave_instrumento": "INS-8", "fecha": "2026-11-08",
 *     "certificado": "CAL-2026-0150", "calibro": "..." }
 *   { "accion": "baja_personal", "matricula": "104523" }              ← la credencial deja de servir
 */
function doPost(e) {
  let d;
  try {
    d = JSON.parse(e.postData.contents);
  } catch (err) {
    return responder({ ok: false, error: 'Formato JSON inválido' });
  }
  if (!CLAVE || d.clave !== CLAVE) return responder({ ok: false, error: 'Clave incorrecta' });

  // Las acciones del encargado piden su nombre y su PIN
  const conPin = ['pin', 'resolver_incidencia', 'calibracion', 'revisar_devolucion', 'baja_personal'];
  if (conPin.includes(d.accion)) {
    const v = verificarEncargado(d.encargado, d.pin);
    if (!v.ok) return responder(v);
    if (d.accion === 'pin') return responder({ ok: true, encargado: v.nombre });
    // Queda registrado quien se identificó, no lo que se escriba en la pantalla
    d.reviso = d.resolvio = d.registro = v.nombre;
  }

  const lock = LockService.getScriptLock();   // evita folios repetidos si llegan dos registros juntos
  try {
    lock.waitLock(10000);
    if (d.accion === 'prestamo') return responder(registrarPrestamo(d));
    if (d.accion === 'personal') return responder(registrarPersonal(d));
    if (d.accion === 'devolucion') return responder(registrarDevolucion(d));
    if (d.accion === 'revisar_devolucion') return responder(revisarDevolucion(d));
    if (d.accion === 'resolver_incidencia') return responder(resolverIncidencia(d));
    if (d.accion === 'calibracion') return responder(registrarCalibracion(d));
    if (d.accion === 'baja_personal') return responder(bajaPersonal(d));
    return responder({ ok: false, error: 'Acción no válida' });
  } catch (err) {
    return responder({ ok: false, error: 'Error del servidor: ' + err.message });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- PRÉSTAMOS ---------- */
function registrarPrestamo(d) {
  const t = buscarTrabajador(d.matricula);
  if (!t) return { ok: false, error: 'Matrícula no registrada' };
  if (esNo(t.activo)) return { ok: false, error: 'La credencial de ' + t.nombre + ' está dada de baja' };

  const item = buscarInstrumento(d.instrumento);
  if (!item) return { ok: false, error: 'Instrumento fuera del catálogo' };

  // No se presta un instrumento con la calibración vencida
  const proxima = proximaCalibracion(item.clave);
  if (proxima && proxima < hoy()) {
    return { ok: false, error: 'La calibración de ' + item.instrumento + ' venció el ' + proxima };
  }

  const cantidad = Number(d.cantidad);
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_CANTIDAD) {
    return { ok: false, error: 'La cantidad debe ser un entero de 1 a ' + MAX_CANTIDAD };
  }

  // El servidor confirma que haya piezas libres (no confía en lo que muestre el iPad)
  const libres = piezasLibres(item);
  if (libres !== null && cantidad > libres) {
    return { ok: false, error: libres ? 'Solo hay ' + libres + ' disponibles de ' + item.instrumento
                                      : 'No hay piezas disponibles de ' + item.instrumento };
  }

  const hoja = libro().getSheetByName('Prestamos');
  const folio = siguienteFolio(hoja, 'ML-');
  const ahora = new Date();
  const fecha = Utilities.formatDate(ahora, ZONA, 'yyyy-MM-dd');
  const hora = Utilities.formatDate(ahora, ZONA, 'HH:mm');

  // Segundos que tardó el registro en la app (desde leer la credencial hasta confirmar).
  // Se acepta solo un número razonable; si no llega, la celda queda vacía.
  const duracion = Number(d.duracion);
  const duracionSeg = isFinite(duracion) && duracion > 0 && duracion < 3600 ? Math.round(duracion * 10) / 10 : '';

  // El apóstrofo guarda el valor como texto (conserva ceros y el formato exacto).
  // Las últimas columnas son: estado, fecha_devolucion, hora_devolucion, recibio, duracion_seg.
  hoja.appendRow([folio, "'" + fecha, "'" + hora, "'" + t.matricula,
                  t.nombre, t.area, t.jefe, d.instrumento, cantidad,
                  'Prestado', '', '', '', duracionSeg]);

  return { ok: true, folio: folio, fecha: fecha, hora: hora, trabajador: t };
}

// Existencias menos lo prestado, lo que está por revisar y lo que tiene incidencia sin resolver.
// null si el catálogo no dice cuántas existencias hay (entonces no se limita).
function piezasLibres(item) {
  const total = parseInt(item.existencias, 10);
  if (!(total > 0)) return null;
  const nombre = String(item.instrumento).trim().toLowerCase();
  const ocupadas = leerHoja('Prestamos')
    .filter(p => (p.estado === 'Prestado' || p.estado === POR_REVISAR) && String(p.instrumento).trim().toLowerCase() === nombre)
    .reduce((s, p) => s + (Number(p.cantidad) || 0), 0);
  const enIncidencia = leerHoja('Incidencias')
    .filter(i => i.estado !== 'Resuelta' && (i.clave ? i.clave === item.clave : String(i.instrumento).trim().toLowerCase() === nombre))
    .reduce((s, i) => s + (parseInt(i.piezas, 10) || 1), 0);
  return Math.max(0, total - ocupadas - enIncidencia);
}

// Siguiente folio con el prefijo dado: ML-0001, INC-0001…
function siguienteFolio(hoja, prefijo) {
  const n = hoja.getLastRow();
  if (n < 2) return prefijo + '0001';
  const folios = hoja.getRange(2, 1, n - 1, 1).getValues().flat();
  const max = folios.reduce((m, f) => {
    const num = parseInt(String(f).replace(prefijo, ''), 10);
    return isNaN(num) ? m : Math.max(m, num);
  }, 0);
  return prefijo + String(max + 1).padStart(4, '0');
}

/* ---------- DEVOLUCIONES ---------- */
// El trabajador solo declara cómo lo regresa: el préstamo queda "Por revisar" y no se presta
// hasta que el encargado lo revise en Mantenimiento (revisarDevolucion).
function registrarDevolucion(d) {
  const folio = String(d.folio || '').trim();
  if (!folio) return { ok: false, error: 'Falta el folio del préstamo' };

  const condicion = d.condicion || 'Bien';
  if (!CONDICIONES.includes(condicion)) return { ok: false, error: 'Condición no válida' };
  const comentario = texto(d.observacion, 200);   // opcional: el encargado es quien describe

  const hoja = libro().getSheetByName('Prestamos');
  const valores = hoja.getDataRange().getDisplayValues();
  const col = columnas(valores[0], ['folio', 'estado', 'fecha_devolucion', 'hora_devolucion', 'recibio', 'declaracion']);
  if (col.faltantes) return { ok: false, error: 'Faltan columnas en Prestamos: ' + col.faltantes };

  const i = valores.findIndex((f, n) => n > 0 && f[col.folio] === folio);
  if (i === -1) return { ok: false, error: 'No existe el préstamo ' + folio };
  if (valores[i][col.estado] !== 'Prestado') {
    return { ok: false, error: 'El préstamo ' + folio + ' ya se había devuelto' };
  }

  const ahora = new Date();
  const fecha = Utilities.formatDate(ahora, ZONA, 'yyyy-MM-dd');
  const hora = Utilities.formatDate(ahora, ZONA, 'HH:mm');
  const recibio = texto(d.recibio, 60);
  const declaracion = texto(condicion + (comentario ? ': ' + comentario : ''), 220);
  const fila = i + 1;   // las filas de la hoja empiezan en 1

  hoja.getRange(fila, col.estado + 1).setValue(POR_REVISAR);
  hoja.getRange(fila, col.fecha_devolucion + 1).setValue("'" + fecha);
  hoja.getRange(fila, col.hora_devolucion + 1).setValue("'" + hora);
  hoja.getRange(fila, col.recibio + 1).setValue(recibio);
  hoja.getRange(fila, col.declaracion + 1).setValue(declaracion);

  return { ok: true, folio: folio, estado: POR_REVISAR, fecha_devolucion: fecha, hora_devolucion: hora,
           recibio: recibio, declaracion: declaracion };
}

// El encargado revisa físicamente el instrumento y confirma su estado real.
// Si el trabajador dijo "Bien" y el encargado encontró un problema, queda marcada la discrepancia.
function revisarDevolucion(d) {
  const folio = String(d.folio || '').trim();
  const condicion = d.condicion || 'Bien';
  if (!CONDICIONES.includes(condicion)) return { ok: false, error: 'Condición no válida' };
  const observacion = texto(d.observacion, 200);
  if (condicion !== 'Bien' && !observacion) return { ok: false, error: 'Describa qué le pasó al instrumento' };
  if (!texto(d.reviso, 60)) return { ok: false, error: 'Falta el nombre del encargado que revisa' };

  const hoja = libro().getSheetByName('Prestamos');
  const valores = hoja.getDataRange().getDisplayValues();
  const enc = valores[0];
  const col = columnas(enc, ['folio', 'estado', 'condicion', 'observaciones', 'declaracion',
                             'reviso', 'fecha_revision', 'hora_revision', 'discrepancia']);
  if (col.faltantes) return { ok: false, error: 'Faltan columnas en Prestamos: ' + col.faltantes };

  const i = valores.findIndex((f, n) => n > 0 && f[col.folio] === folio);
  if (i === -1) return { ok: false, error: 'No existe el préstamo ' + folio };
  if (valores[i][col.estado] !== POR_REVISAR) {
    return { ok: false, error: 'El préstamo ' + folio + ' no está por revisar' };
  }
  const prestamo = Object.fromEntries(enc.map((h, n) => [h, valores[i][n]]));
  const cantidad = Number(prestamo.cantidad) || 1;
  const piezas = Number(d.piezas) || 1;
  if (condicion !== 'Bien' && (!Number.isInteger(piezas) || piezas < 1 || piezas > cantidad)) {
    return { ok: false, error: 'Las piezas afectadas deben ser de 1 a ' + cantidad };
  }

  // Discrepancia solo si dijo "Bien" y no lo estaba; reportar un daño con honestidad no cuenta
  const declarada = String(prestamo.declaracion || '').split(':')[0].trim();
  const discrepancia = declarada === 'Bien' && condicion !== 'Bien' ? SI : 'No';

  const ahora = new Date();
  const fecha = Utilities.formatDate(ahora, ZONA, 'yyyy-MM-dd');
  const hora = Utilities.formatDate(ahora, ZONA, 'HH:mm');
  const reviso = texto(d.reviso, 60);
  const fila = i + 1;
  hoja.getRange(fila, col.estado + 1).setValue('Devuelto');
  hoja.getRange(fila, col.condicion + 1).setValue(condicion);
  hoja.getRange(fila, col.observaciones + 1).setValue(observacion);
  hoja.getRange(fila, col.reviso + 1).setValue(reviso);
  hoja.getRange(fila, col.fecha_revision + 1).setValue("'" + fecha);
  hoja.getRange(fila, col.hora_revision + 1).setValue("'" + hora);
  hoja.getRange(fila, col.discrepancia + 1).setValue(discrepancia);

  let incidencia = '', estadoInc = '';
  if (condicion !== 'Bien') {
    const hojaInc = libro().getSheetByName('Incidencias');
    if (!hojaInc) return { ok: false, error: 'Falta la pestaña Incidencias' };
    const item = buscarInstrumento(prestamo.instrumento);
    const cal = !!d.requiere_calibracion;
    incidencia = siguienteFolio(hojaInc, 'INC-');
    // "Requiere calibración": queda bloqueado hasta registrar la calibración
    estadoInc = cal ? EN_CALIBRACION : 'Abierta';
    hojaInc.appendRow([incidencia, "'" + fecha, "'" + hora, folio, item ? item.clave : '', prestamo.instrumento,
                       piezas, "'" + prestamo.matricula, prestamo.nombre, prestamo.area,
                       condicion, observacion, estadoInc,
                       cal ? "'" + fecha : '', cal ? CALIBRACION : '', cal ? reviso : '', '']);
  }

  return { ok: true, folio: folio, estado: 'Devuelto', condicion: condicion, discrepancia: discrepancia,
           fecha_revision: fecha, hora_revision: hora, reviso: reviso, incidencia: incidencia, estado_incidencia: estadoInc };
}

/* ---------- MANTENIMIENTO: incidencias ---------- */
// Reparado → vuelve a prestarse · Calibración → sigue bloqueado hasta calibrarlo · Baja → se resta de existencias
function resolverIncidencia(d) {
  const id = String(d.id || '').trim();
  const resolucion = d.resolucion;
  if (!RESOLUCIONES.includes(resolucion)) return { ok: false, error: 'Resolución no válida' };

  const hoja = libro().getSheetByName('Incidencias');
  const valores = hoja.getDataRange().getDisplayValues();
  const col = columnas(valores[0], ['id', 'clave', 'piezas', 'estado', 'fecha_resolucion', 'resolucion', 'resolvio', 'nota']);
  if (col.faltantes) return { ok: false, error: 'Faltan columnas en Incidencias: ' + col.faltantes };

  const i = valores.findIndex((f, n) => n > 0 && f[col.id] === id);
  if (i === -1) return { ok: false, error: 'No existe la incidencia ' + id };
  const actual = valores[i][col.estado];
  if (actual === 'Resuelta') return { ok: false, error: 'La incidencia ' + id + ' ya estaba resuelta' };
  if (actual === EN_CALIBRACION && resolucion === CALIBRACION) {
    return { ok: false, error: 'Ya está esperando calibración: registre la calibración del instrumento' };
  }

  const fecha = hoy();
  const nuevoEstado = resolucion === CALIBRACION ? EN_CALIBRACION : 'Resuelta';
  const fila = i + 1;
  hoja.getRange(fila, col.estado + 1).setValue(nuevoEstado);
  hoja.getRange(fila, col.fecha_resolucion + 1).setValue("'" + fecha);
  hoja.getRange(fila, col.resolucion + 1).setValue(resolucion);
  hoja.getRange(fila, col.resolvio + 1).setValue(texto(d.resolvio, 60));
  hoja.getRange(fila, col.nota + 1).setValue(texto(d.nota, 200));

  // Dado de baja: la pieza ya no existe en el laboratorio
  let existencias = null;
  if (resolucion === 'Baja') existencias = restarExistencias(valores[i][col.clave], Number(valores[i][col.piezas]) || 1);

  return { ok: true, id: id, estado: nuevoEstado, fecha_resolucion: fecha, existencias: existencias };
}

function restarExistencias(clave, piezas) {
  const hoja = libro().getSheetByName('Catalogo');
  const valores = hoja.getDataRange().getDisplayValues();
  const cClave = valores[0].indexOf('clave'), cExist = valores[0].indexOf('existencias');
  if (cClave === -1 || cExist === -1) return null;
  const i = valores.findIndex((f, n) => n > 0 && f[cClave] === clave);
  if (i === -1) return null;
  const nuevo = Math.max(0, (parseInt(valores[i][cExist], 10) || 0) - piezas);
  hoja.getRange(i + 1, cExist + 1).setValue(nuevo);
  return nuevo;
}

/* ---------- MANTENIMIENTO: calibraciones ---------- */
// Agrega una fila al historial de calibraciones y libera las piezas que esperaban calibración
function registrarCalibracion(d) {
  const item = leerHoja('Catalogo').find(c => c.clave === String(d.clave_instrumento || '').trim());
  if (!item) return { ok: false, error: 'Instrumento no encontrado' };

  const fecha = fechaISO(d.fecha);
  if (!fecha) return { ok: false, error: 'Fecha de calibración no válida' };
  if (fecha > hoy()) return { ok: false, error: 'La fecha de calibración no puede ser futura' };
  const certificado = texto(d.certificado, 40);
  if (!certificado) return { ok: false, error: 'Escriba el número de certificado' };

  const meses = parseInt(item.frecuencia_meses, 10) || 12;
  // Suma los meses sin pasarse de fin de mes: 31 ene + 1 mes = 28 feb
  const [a, m, dia] = fecha.split('-').map(Number);
  const f = new Date(a, m - 1 + meses, 1, 12);
  f.setDate(Math.min(dia, new Date(f.getFullYear(), f.getMonth() + 1, 0).getDate()));
  const proxima = Utilities.formatDate(f, ZONA, 'yyyy-MM-dd');

  libro().getSheetByName('Calibraciones').appendRow(["'" + fecha, item.clave, item.instrumento, certificado,
    texto(d.calibro, 60), "'" + proxima, texto(d.registro, 60)]);

  // Las piezas que esperaban calibración quedan resueltas
  const hojaInc = libro().getSheetByName('Incidencias');
  let liberadas = 0;
  if (hojaInc) {
    const valores = hojaInc.getDataRange().getDisplayValues();
    const col = columnas(valores[0], ['clave', 'estado', 'fecha_resolucion', 'nota']);
    if (!col.faltantes) {
      valores.forEach((f, n) => {
        if (n === 0 || f[col.clave] !== item.clave || f[col.estado] !== EN_CALIBRACION) return;
        hojaInc.getRange(n + 1, col.estado + 1).setValue('Resuelta');
        hojaInc.getRange(n + 1, col.fecha_resolucion + 1).setValue("'" + fecha);
        hojaInc.getRange(n + 1, col.nota + 1).setValue(texto((f[col.nota] ? f[col.nota] + ' · ' : '') + 'Calibrado, certificado ' + certificado, 200));
        liberadas++;
      });
    }
  }
  return { ok: true, clave: item.clave, fecha: fecha, proxima: proxima, certificado: certificado, liberadas: liberadas };
}

// Próxima calibración (yyyy-MM-dd) según la calibración más reciente del instrumento; '' si no hay
function proximaCalibracion(clave) {
  const hoja = libro().getSheetByName('Calibraciones');
  if (!hoja) return '';
  const ultima = leerHoja('Calibraciones')
    .filter(c => c.clave === clave && fechaISO(c.fecha))
    .sort((x, y) => fechaISO(y.fecha).localeCompare(fechaISO(x.fecha)))[0];
  return ultima ? fechaISO(ultima.proxima) : '';
}

/* ---------- PERSONAL (generador de QR) ---------- */
function registrarPersonal(d) {
  const m = String(d.matricula || '').trim();
  const nombre = String(d.nombre || '').trim();
  const area = String(d.area || '').trim();
  const jefe = String(d.jefe || '').trim();

  if (!/^\d{5,8}$/.test(m)) return { ok: false, error: 'La matrícula debe tener de 5 a 8 dígitos' };
  if (!nombre || nombre.length > 60) return { ok: false, error: 'Nombre vacío o mayor a 60 caracteres' };

  const areas = leerHoja('Areas');
  if (!areas.some(a => a.area === area)) return { ok: false, error: 'Área no válida' };
  if (!areas.some(a => a.jefe === jefe)) return { ok: false, error: 'Jefe no válido' };
  if (buscarTrabajador(m)) return { ok: false, error: 'La matrícula ya está registrada' };

  libro().getSheetByName('Personal').appendRow(["'" + m, texto(nombre, 60), area, jefe, SI]);
  return { ok: true, trabajador: { matricula: m, nombre: nombre, area: area, jefe: jefe, activo: SI } };
}

// La credencial deja de servir para pedir préstamos (se reactiva escribiendo Sí en la hoja)
function bajaPersonal(d) {
  const norm = x => String(x).trim().replace(/^0+/, '');
  const m = String(d.matricula || '').trim();
  if (!/^\d{5,8}$/.test(m)) return { ok: false, error: 'La matrícula debe tener de 5 a 8 dígitos' };
  const hoja = libro().getSheetByName('Personal');
  const valores = hoja.getDataRange().getDisplayValues();
  const col = columnas(valores[0], ['matricula', 'nombre', 'activo']);
  if (col.faltantes) return { ok: false, error: 'Faltan columnas en Personal: ' + col.faltantes };
  const i = valores.findIndex((f, n) => n > 0 && norm(f[col.matricula]) === norm(m));
  if (i === -1) return { ok: false, error: 'Matrícula no registrada' };
  if (esNo(valores[i][col.activo])) return { ok: false, error: 'La credencial ya estaba dada de baja' };
  hoja.getRange(i + 1, col.activo + 1).setValue('No');
  return { ok: true, matricula: m, nombre: valores[i][col.nombre] };
}

/* ---------- ENCARGADOS (PIN individual) ---------- */
// Devuelve { ok, nombre } con el nombre tal como está en la hoja, o { ok:false, error }.
// shortcut: un PIN de 4-8 dígitos con SHA-256 se puede adivinar si alguien copia la hoja;
// la protección real es que la hoja no sea pública. Usar contraseñas si eso cambia.
function verificarEncargado(nombre, pin) {
  const norm = normNombre(nombre);
  pin = String(pin || '').trim();
  if (!norm || !/^\d{4,8}$/.test(pin)) return { ok: false, error: 'PIN incorrecto' };

  const cache = CacheService.getScriptCache();
  const llave = 'fallos_' + norm.slice(0, 60);
  const fallos = Number(cache.get(llave)) || 0;
  if (fallos >= MAX_INTENTOS) return { ok: false, error: 'Demasiados intentos fallidos. Espere 15 minutos.' };

  const hoja = libro().getSheetByName('Encargados');
  if (!hoja) return { ok: false, error: 'Falta la pestaña Encargados' };
  const valores = hoja.getDataRange().getDisplayValues();
  const col = columnas(valores[0], ['nombre', 'pin_nuevo', 'pin_hash', 'activo']);
  if (col.faltantes) return { ok: false, error: 'Faltan columnas en Encargados: ' + col.faltantes };

  const i = valores.findIndex((f, n) => n > 0 && normNombre(f[col.nombre]) === norm && !esNo(f[col.activo]));
  const hash = hashPin(norm, pin);
  let valido = false;
  if (i > 0) {
    const nuevo = String(valores[i][col.pin_nuevo]).trim();
    if (nuevo) {
      // PIN recién asignado: se acepta una vez y se reemplaza por su hash
      valido = nuevo === pin;
      if (valido) {
        hoja.getRange(i + 1, col.pin_hash + 1).setValue(hash);
        hoja.getRange(i + 1, col.pin_nuevo + 1).setValue('');
      }
    } else {
      valido = valores[i][col.pin_hash] === hash;
    }
  }
  if (!valido) {
    cache.put(llave, String(fallos + 1), BLOQUEO_SEG);
    return { ok: false, error: 'PIN incorrecto' };
  }
  cache.remove(llave);
  return { ok: true, nombre: valores[i][col.nombre].trim() };
}

function hashPin(nombreNorm, pin) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'managerlab:' + nombreNorm + ':' + pin, Utilities.Charset.UTF_8);
  return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

// "  José  Pérez" y "jose perez" son el mismo encargado
function normNombre(x) {
  return String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Celda "No" (sin importar mayúsculas); vacío cuenta como activo
function esNo(v) {
  return String(v || '').trim().toLowerCase() === 'no';
}

/* ---------- UTILIDADES ---------- */
function libro() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

// Lee una pestaña y la devuelve como lista de objetos usando la fila 1 como nombres.
function leerHoja(nombre) {
  const hoja = libro().getSheetByName(nombre);
  if (!hoja) return [];
  const valores = hoja.getDataRange().getDisplayValues();
  const enc = valores[0];
  return valores.slice(1)
    .filter(f => f.some(v => v !== ''))
    .map(f => Object.fromEntries(enc.map((h, i) => [h, f[i]])));
}

// Posición de cada columna por su encabezado; "faltantes" lista las que no existen
function columnas(enc, nombres) {
  const col = {};
  nombres.forEach(n => (col[n] = enc.indexOf(n)));
  const faltan = nombres.filter(n => col[n] === -1);
  if (faltan.length) col.faltantes = faltan.join(', ');
  return col;
}

// Compara matrículas ignorando ceros a la izquierda (por si Sheets los quitó).
function buscarTrabajador(matricula) {
  const norm = x => String(x).trim().replace(/^0+/, '');
  const t = leerHoja('Personal').find(p => norm(p.matricula) === norm(matricula));
  return t ? Object.assign({}, t, { matricula: String(matricula).trim() }) : null;
}

// Busca en el catálogo ignorando mayúsculas y espacios sobrantes
function buscarInstrumento(nombre) {
  const norm = x => String(x || '').trim().toLowerCase();
  return leerHoja('Catalogo').find(c => norm(c.instrumento) === norm(nombre)) || null;
}

function hoy() {
  return Utilities.formatDate(new Date(), ZONA, 'yyyy-MM-dd');
}

// Acepta 2026-11-08 o 08/11/2026 (por si alguien escribe la fecha a mano en la hoja)
function fechaISO(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return '';
}

// Texto libre escrito en la app: recortado y sin que Sheets lo interprete como fórmula
function texto(v, max) {
  const s = String(v || '').trim().slice(0, max);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function responder(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Ejecútenla una vez desde el editor (botón ▶ Ejecutar) para autorizar el script
// y comprobar que lee la hoja. El resultado aparece en el "Registro de ejecución".
function probar() {
  Logger.log(JSON.stringify(leerHoja('Catalogo').slice(0, 2)));
  Logger.log(JSON.stringify(leerHoja('Prestamos').slice(-3)));      // últimos 3 préstamos con su estado
  Logger.log('Próxima calibración INS-8: ' + proximaCalibracion('INS-8'));
  Logger.log(JSON.stringify(leerHoja('Incidencias')));
  Logger.log(fechaISO('08/11/2026') === '2026-11-08' && fechaISO('2026-1-5') === '2026-01-05' ? 'fechaISO OK' : 'fechaISO FALLA');
  Logger.log(CLAVE ? 'CLAVE configurada' : 'FALTA la propiedad CLAVE (Configuración del proyecto)');
  Logger.log(normNombre(' José  PÉREZ ') === 'jose perez' && esNo(' no ') && !esNo('') ? 'normNombre/esNo OK' : 'normNombre/esNo FALLA');
  Logger.log(hashPin('a', '1234') === hashPin('a', '1234') && hashPin('a', '1234') !== hashPin('b', '1234') ? 'hashPin OK' : 'hashPin FALLA');
}
