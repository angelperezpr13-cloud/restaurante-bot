require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const http = require('http');
const axios = require('axios');
const path = require('path');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const PORT = process.env.PORT || 3000;

// Estado del código QR para la interfaz web
let currentQrDataUrl = null;
let isConnected = false;

// Memoria de conversación por usuario
const chatHistories = new Map();

// Prompt del sistema con toda la información del restaurante
const SYSTEM_PROMPT = `
Eres "Bella", la asistente virtual inteligente de la "Trattoria & Pizzería Bella Vista".
Tu objetivo es atender a los clientes por WhatsApp con calidez, amabilidad y eficiencia.

DATOS DEL RESTAURANTE:
- Especialidad: Comida italiana artesanal y pizzas al horno de leña.
- Horario: Martes a Domingo de 12:00 PM a 11:00 PM (Lunes cerrado).
- Dirección: Av. Principal de Las Mercedes, Edificio Bella Vista, Caracas.
- Métodos de pago: Dólares en efectivo, Zelle, Pago Móvil y Tarjetas internacionales.
- Estacionamiento: Sí, contamos con valet parking gratuito.

MENÚ Y PRECIOS:
- Pizzas al Horno de Leña (Masa madre):
  * Margherita ($10): Salsa de tomate, mozzarella fior di latte y albahaca fresca.
  * Pepperoni Clásica ($12): Mozzarella y abundante pepperoni artesanal.
  * Cuatro Quesos ($13): Mozzarella, gorgonzola, provolone y parmesano.
  * Bella Vista Especial ($14): Jamón serrano, rúcula, tomates cherry y reducción balsámica.
- Pastas Frescas:
  * Lasagna Bolognese ($12): Capas de pasta fresca, carne molida en salsa boloñesa y bechamel gratinada.
  * Fettuccine Alfredo ($11): En cremosa salsa de mantequilla y parmesano (con Pollo +$3).
  * Spaghetti Carbonara ($12): Panceta crujiente, yema de huevo, pimienta y queso pecorino.
  * Raviolis de Ricotta y Espinaca ($11): Con salsa pomodoro (Opción Vegetariana).
- Entradas:
  * Bruschetta Tradicional ($6): Pan campesino tostado, tomates frescos, albahaca y aceite de oliva virgen.
  * Carpaccio de Lomo ($9): Finas láminas de carne de res con lascas de parmesano y rúcula.
- Postres:
  * Tiramisú Clásico ($5): Con espresso y queso mascarpone.
  * Panna Cotta de Frutos Rojos ($5).
- Bebidas:
  * Refrescos y Aguas ($2), Cerveza Nacional ($3), Copa de Vino ($5).

REGLAS DE ATENCIÓN:
1. Saluda amablemente y mantén un tono educado, cercano y fresco (usa emojis con buen gusto 🍕🍝).
2. Responde de forma clara y directa (estás en WhatsApp, no escribas bloques enormes).
3. Si preguntan por pizzas o menú, da los nombres y sus precios exactos según la lista anterior.
4. Para RESERVAS: Pide siempre (1) Nombre completo, (2) Número de personas, (3) Fecha y (4) Hora. Confírmale la reserva con un resumen.
5. Opciones dietéticas: Tenemos opciones vegetarianas (Raviolis, Margherita, Bruschettas) y avisando con antelación adaptamos para celíacos.
`;

// Modelos comprobados y funcionales sin saturación
const MODELS_TO_TRY = [
    'dots-studio/dots-3-note-preview:free',
    'cohere/north-mini-code:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free'
];

// Función para consultar a la IA con memoria de chat
async function getAiResponse(userJid, userMessage) {
    if (!chatHistories.has(userJid)) {
        chatHistories.set(userJid, []);
    }
    const history = chatHistories.get(userJid);
    
    // Agregar mensaje del usuario al historial
    history.push({ role: 'user', content: userMessage });
    
    // Mantener sólo los últimos 8 mensajes
    if (history.length > 8) {
        history.splice(0, history.length - 8);
    }
    
    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...history
    ];
    
    for (const model of MODELS_TO_TRY) {
        try {
            const response = await axios.post(
                'https://openrouter.ai/api/v1/chat/completions',
                {
                    model: model,
                    messages: messages,
                    temperature: 0.6,
                    max_tokens: 450
                },
                {
                    headers: {
                        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': 'https://github.com/restaurante-bot',
                        'X-Title': 'Restaurante Bot'
                    },
                    timeout: 15000
                }
            );
            
            const reply = response.data?.choices?.[0]?.message?.content?.trim();
            if (reply && reply.length > 0) {
                // Guardar respuesta del bot en el historial
                history.push({ role: 'assistant', content: reply });
                return reply;
            }
        } catch (err) {
            console.error(`Error con modelo ${model}:`, err.response?.data?.error?.message || err.message);
        }
    }
    
    return "¡Hola! Tenemos disponibles nuestras Pizzas al Horno de Leña: Margherita ($10), Pepperoni ($12), Cuatro Quesos ($13) y Bella Vista Especial ($14). ¿Te gustaría ordenar alguna o reservar una mesa?";
}

// Servidor Web local para ver estado y QR
const server = http.createServer((req, res) => {
    if (req.url === '/ping' || req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('OK');
    }
    if (req.url === '/qr' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (isConnected) {
            res.end(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>WhatsApp Bot - Conectado</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <style>
                        body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0b141a; color: white; }
                        .card { background: #111b21; padding: 40px; border-radius: 16px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); max-width: 420px; }
                        .success { color: #00a884; font-size: 50px; margin-bottom: 10px; }
                        h2 { margin: 0 0 10px; color: #e9edef; }
                        p { color: #8696a0; font-size: 14px; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <div class="success">✓</div>
                        <h2>¡WhatsApp Conectado!</h2>
                        <p>El bot de <b>Trattoria Bella Vista</b> está activo y respondiendo mensajes en tiempo real.</p>
                    </div>
                </body>
                </html>
            `);
        } else if (currentQrDataUrl) {
            res.end(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Vincular WhatsApp - Restaurante Bot</title>
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <meta http-equiv="refresh" content="6">
                    <style>
                        body { font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0b141a; color: white; }
                        .card { background: #111b21; padding: 30px; border-radius: 16px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); max-width: 420px; }
                        h2 { margin: 0 0 15px; color: #00a884; }
                        ol { text-align: left; color: #aebac1; font-size: 14px; line-height: 1.6; padding-left: 20px; }
                        img { border: 8px solid white; border-radius: 8px; margin: 15px 0; max-width: 260px; height: auto; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h2>Vincular WhatsApp</h2>
                        <ol>
                            <li>Abre <b>WhatsApp</b> en tu teléfono.</li>
                            <li>Toca <b>Dispositivos vinculados</b> y <b>Vincular dispositivo</b>.</li>
                            <li>Escanea este código:</li>
                        </ol>
                        <img src="${currentQrDataUrl}" alt="Código QR WhatsApp" />
                    </div>
                </body>
                </html>
            `);
        } else {
            res.end(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta http-equiv="refresh" content="2">
                    <style>body { font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; background: #111b21; color: white; }</style>
                </head>
                <body>
                    <p>Reconectando con tu sesión de WhatsApp...</p>
                </body>
                </html>
            `);
        }
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(PORT, () => {
    console.log(`🌐 Servidor activo en: http://localhost:${PORT}/qr`);
});

// Inicializar conexión con WhatsApp (Baileys)
async function startWhatsAppBot() {
    const authPath = path.join(__dirname, 'auth_info');
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: ['RestauranteBot', 'Chrome', '1.0.0']
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('\n📱 Código QR disponible en: http://localhost:' + PORT + '/qr\n');
            try {
                currentQrDataUrl = await QRCode.toDataURL(qr);
            } catch (e) {}
        }
        
        if (connection === 'close') {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Conexión cerrada. Reconectando: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(startWhatsAppBot, 2000);
            }
        } else if (connection === 'open') {
            isConnected = true;
            currentQrDataUrl = null;
            console.log('\n🎉 ¡CONECTADO A WHATSAPP CON ÉXITO!');
            console.log('🤖 Bella está lista para responder mensajes.\n');
        }
    });
    
    // Escuchar mensajes entrantes
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        
        for (const msg of messages) {
            // Ignorar mensajes enviados por el bot mismo o estados
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid.includes('@broadcast')) continue;
            
            // Ignorar grupos
            if (msg.key.remoteJid.endsWith('@g.us')) continue;
            
            // Extraer el texto del mensaje
            const text = msg.message.conversation || 
                         msg.message.extendedTextMessage?.text || 
                         msg.message.imageMessage?.caption || 
                         '';
            
            if (!text.trim()) continue;
            
            const senderJid = msg.key.remoteJid;
            const pushName = msg.pushName || 'Cliente';
            console.log(`📩 Mensaje recibido de ${pushName}: "${text}"`);
            
            // Indicar que el bot está escribiendo (typing)
            try {
                await sock.sendPresenceUpdate('composing', senderJid);
            } catch (e) {}
            
            // Obtener respuesta de la IA
            const aiReply = await getAiResponse(senderJid, text);
            console.log(`🤖 Respuesta enviada a ${pushName}: "${aiReply}"\n`);
            
            // Enviar respuesta por WhatsApp
            try {
                await sock.sendPresenceUpdate('paused', senderJid);
                await sock.sendMessage(senderJid, { text: aiReply });
            } catch (err) {
                console.error('Error enviando mensaje de WhatsApp:', err);
            }
        }
    });
}

startWhatsAppBot().catch(err => {
    console.error('Error fatal iniciando bot:', err);
});
