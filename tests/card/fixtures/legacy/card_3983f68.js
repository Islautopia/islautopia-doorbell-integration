// Marca de build (2026-07-12, ver COORDINATION.md Q24-quater y memoria persistente
// hass_card_audio_investigation.md en el repo del firmware) - PROBLEMA REAL ENCONTRADO al
// investigar si el fix de audio de Q24-bis (addTransceiver->addTrack) llega de verdad al HA real
// del usuario: el recurso Lovelace manual (`/local/ig-doorbell-card.js`, ver README.md
// "Manual Installation") se registra con una URL PELADA, sin ningun sufijo de version/cache-bust
// (a diferencia del recurso instalado via HACS, `/hacsfiles/...`, que SI lleva un `?hacstagXXXXXXX`
// que HACS gestiona solo para poder forzar recarga en cada actualizacion). Consecuencia real: un
// navegador que ya cargo ese modulo JS puede seguir sirviendolo desde su propia cache HTTP/de
// modulos ES indefinidamente, aunque el fichero en `config/www/` del host ya se haya sobrescrito
// con una version corregida - sin ningun cambio en la URL, no hay señal que le diga al navegador
// "esto es distinto, vuelve a descargarlo". Esto explica por que no se puede confirmar con certeza
// desde el repo si un fix concreto esta realmente sirviendo en el HA de un usuario: el fichero en
// disco y lo que el navegador tiene cacheado pueden divergir sin ningun error visible.
// Este console.log (se ejecuta SIEMPRE al cargar el modulo, incluso antes de que exista ninguna
// instancia de la card) da una forma barata y objetiva de zanjar la duda desde las DevTools reales:
// si el `build` que aparece aqui no coincide con el de este mismo fichero en el repo, el navegador
// esta sirviendo una copia vieja cacheada - hace falta forzar recarga (Ctrl+Shift+R) o, mejor,
// cambiar la URL del recurso (ver nota en README.md) para que esto no vuelva a pasar en el futuro.
const CARD_BUILD_ID = '2026-09-07-el-plazo-de-inactividad-es-absoluto';

// ⚠️ ESTA MARCA VIVE EN EL MODULO Y NO EN EL ELEMENTO, Y ESA ES TODA LA GRACIA (2026-09-07).
//
// La cuenta atras de inactividad ya no se rearmaba con cada reconexion del stream (v1.5.1), y aun
// asi seguia sin dispararse en el panel de pared. La sesion de HASS lo midio: con
// `idle_release_seconds: 60`, a los 80 s los wake locks seguian retenidos.
//
// Su hipotesis, y era la buena: **si Home Assistant destruye y recrea el elemento de la card en la
// reconexion, la instancia nueva arranca su propia cuenta desde cero.** Todo el estado vivia en
// `this`, asi que el arreglo anterior cubria "rearmar el mismo temporizador" y NO cubria "instancia
// nueva con temporizador nuevo". Con reconexiones cada 30-45 s, un plazo de 60 no llega nunca.
//
// La solucion no es guardar el temporizador, es **cambiar lo que significa el plazo**: pasa de ser
// relativo ("60 s desde que lo armo") a absoluto ("60 s desde el ultimo dedo"). Con un instante de
// referencia que sobrevive al elemento, rearmar y recrear dejan de importar los dos a la vez --
// y una instancia nueva que nace cuando ya han pasado 60 s suelta INMEDIATAMENTE, en vez de
// regalar otro minuto.
let LAST_INTERACTION_MS = Date.now();
console.log(`[ig-doorbell-card] modulo cargado - build=${CARD_BUILD_ID} (compara este valor contra CARD_BUILD_ID en el repo si tienes dudas de si el navegador esta sirviendo una copia cacheada vieja)`);

// Diccionario global de traducciones para Tarjeta y Editor (Top 9 Idiomas + HA Community)
const igLocales = {
  es: { // Español
    connecting: "Conectando...", live: "En directo", open: "Comms Abiertas", error_cam: "Error", no_lock: "Sin cerradura configurada",
    motion_detected: "Movimiento detectado", audio_active: "Audio activo", idle_status: "Sistema operativo", door_open_prefix: "Puerta abierta · Cerrando en",
    lbl_mic_off: "Micrófono", lbl_mic_on: "Activo", lbl_door_idle: "Puerta", lbl_door_open: "Abierta",
    talk_requesting: "Pidiendo turno...", talk_denied_msg: "Canal de voz ocupado por otro usuario", talk_busy: "Canal de voz en uso",
    talk_taken: "Otro usuario ha tomado el canal de voz", talk_silence: "El portero cerró el canal de voz por silencio",
    talk_legacy: "Este portero no confirma el turno de voz (firmware anterior)", lbl_mic_listen: "Escucha", clients_tip: "Clientes conectados",
    q_label: "Calidad", q_auto: "Auto", q_full: "Alta", q_low: "Baja", q_audio_only: "Solo audio",
    q_auto_loss: "Calidad ajustada automáticamente: pérdida de paquetes", q_auto_bw: "Calidad ajustada automáticamente: ancho de banda insuficiente",
    q_auto_sub: "El portero decide", q_full_sub: "Vídeo completo", q_low_sub: "~1 imagen/s (solo claves)", q_audio_only_sub: "Sin vídeo, solo sonido",
    q_low_warn: "Calidad baja: ~1 imagen por segundo. No es una avería.", talk_free_retry: "Canal de voz libre — ya puedes hablar",
    fs_enter: "Pantalla completa", fs_exit: "Salir de pantalla completa",
    door_confirm: "¿Abrir la puerta? Pulsa otra vez", lbl_door_confirm: "¿Abrir?",
    snd_on: "Silenciar", snd_off: "Escuchar", snd_ring: "Están llamando — sonido activado",
    door_opening: "Abriendo la puerta...", lbl_door_opening: "Abriendo", door_no_answer: "El portero no respondió — la puerta NO se ha abierto",
    conn_relay: "El camino local no responde · conectando por la nube", retry_prefix: "Sin conexión · reintentando en",
    snd_blocked: "Toca el altavoz para oír", cred_revoked: "El portero rechazó el emparejamiento — vuelve a emparejarlo en Ajustes › Dispositivos y servicios",
    ed_device_id: "Device ID nativo IG Doorbell (recomendado - ver Ajustes > Dispositivos y servicios)",
    ed_mode_entity: "Entidad de Modo (Opcional - select.* para mostrar los chips Normal/Ausente/Noche/Custom)",
    ed_motion_entity: "Entidad de Movimiento (Opcional - binary_sensor.* para el aviso de movimiento sobre el vídeo)",
    ed_ring_entity: "Entidad de Timbre (Opcional - binary_sensor.* del timbre: al sonar, la card enciende el sonido sola)",
    ed_entity: "Entidad de Apertura/Relé (Opcional - si se omite con Device ID, se usa la apertura nativa)", ed_duration: "Segundos de Auto-Cierre (1-20)", ed_height: "Altura de la tarjeta (Ej: 400px, 600px, auto)"
  },
  en: { // Inglés (Fallback global)
    connecting: "Connecting...", live: "Live", open: "Comms Open", error_cam: "Error", no_lock: "No lock configured",
    motion_detected: "Motion detected", audio_active: "Audio active", idle_status: "System idle", door_open_prefix: "Door open · Closing in",
    lbl_mic_off: "Microphone", lbl_mic_on: "Active", lbl_door_idle: "Door", lbl_door_open: "Open",
    talk_requesting: "Requesting turn...", talk_denied_msg: "Voice channel busy (another user)", talk_busy: "Voice channel in use",
    talk_taken: "Another user took the voice channel", talk_silence: "The doorbell closed the voice channel after silence",
    talk_legacy: "This doorbell doesn't confirm voice turns (older firmware)", lbl_mic_listen: "Listening", clients_tip: "Connected clients",
    q_label: "Quality", q_auto: "Auto", q_full: "High", q_low: "Low", q_audio_only: "Audio only",
    q_auto_loss: "Quality auto-adjusted: packet loss", q_auto_bw: "Quality auto-adjusted: not enough bandwidth",
    q_auto_sub: "The doorbell decides", q_full_sub: "Full video", q_low_sub: "~1 frame/s (keyframes only)", q_audio_only_sub: "No video, sound only",
    q_low_warn: "Low quality: about 1 frame per second. This is not a fault.", talk_free_retry: "Voice channel free — you can talk now",
    fs_enter: "Fullscreen", fs_exit: "Exit fullscreen",
    door_confirm: "Open the door? Press again", lbl_door_confirm: "Open?",
    snd_on: "Mute", snd_off: "Listen", snd_ring: "Someone is calling — sound on",
    door_opening: "Opening the door...", lbl_door_opening: "Opening", door_no_answer: "No answer from the doorbell — the door did NOT open",
    conn_relay: "Local path not answering · connecting via the cloud", retry_prefix: "No connection · retrying in",
    snd_blocked: "Tap the speaker to listen", cred_revoked: "The doorbell rejected this pairing — re-pair it in Settings › Devices & services",
    ed_device_id: "Native IG Doorbell Device ID (recommended - see Settings > Devices & services)",
    ed_mode_entity: "Mode Entity (Optional - select.* to show the Normal/Away/Night/Custom chips)",
    ed_motion_entity: "Motion Entity (Optional - binary_sensor.* for the motion badge over the video)",
    ed_ring_entity: "Doorbell/Ring Entity (Optional - binary_sensor.* of the chime: the card turns sound on by itself when it rings)",
    ed_entity: "Unlock/Relay Entity (Optional - if left blank with a Device ID, native door-open is used)", ed_duration: "Auto-Close Seconds (1-20)", ed_height: "Card Height (Ex: 400px, 600px, auto)"
  },
  pt: { // Portugués
    connecting: "Conectando...", live: "Ao vivo", open: "Comms Abertas", error_cam: "Erro", no_lock: "Sem fechadura configurada",
    motion_detected: "Movimento detectado", audio_active: "Áudio ativo", idle_status: "Sistema em repouso", door_open_prefix: "Porta aberta · Fechando em",
    lbl_mic_off: "Microfone", lbl_mic_on: "Ativo", lbl_door_idle: "Porta", lbl_door_open: "Aberta",
    talk_requesting: "A pedir a vez...", talk_denied_msg: "Canal de voz ocupado por outro utilizador", talk_busy: "Canal de voz em uso",
    talk_taken: "Outro utilizador tomou o canal de voz", talk_silence: "O porteiro fechou o canal de voz por silêncio",
    talk_legacy: "Este porteiro não confirma a vez de voz (firmware anterior)", lbl_mic_listen: "A ouvir", clients_tip: "Clientes ligados",
    q_label: "Qualidade", q_auto: "Auto", q_full: "Alta", q_low: "Baixa", q_audio_only: "Só áudio",
    q_auto_loss: "Qualidade ajustada automaticamente: perda de pacotes", q_auto_bw: "Qualidade ajustada automaticamente: largura de banda insuficiente",
    q_auto_sub: "O porteiro decide", q_full_sub: "Vídeo completo", q_low_sub: "~1 imagem/s (só chaves)", q_audio_only_sub: "Sem vídeo, só som",
    q_low_warn: "Qualidade baixa: ~1 imagem por segundo. Não é avaria.", talk_free_retry: "Canal de voz livre — já pode falar",
    fs_enter: "Ecrã inteiro", fs_exit: "Sair do ecrã inteiro",
    door_confirm: "Abrir a porta? Prima outra vez", lbl_door_confirm: "Abrir?",
    snd_on: "Silenciar", snd_off: "Ouvir", snd_ring: "Estão a chamar — som ligado",
    door_opening: "A abrir a porta...", lbl_door_opening: "A abrir", door_no_answer: "O porteiro não respondeu — a porta NÃO foi aberta",
    conn_relay: "O caminho local não responde · a ligar pela nuvem", retry_prefix: "Sem ligação · a tentar de novo em",
    snd_blocked: "Toque no altifalante para ouvir", cred_revoked: "O porteiro rejeitou este emparelhamento — volte a emparelhá-lo em Definições › Dispositivos e serviços",
    ed_device_id: "Device ID nativo do IG Doorbell (recomendado)",
    ed_mode_entity: "Entidade de Modo (Opcional - select.* para mostrar os chips Normal/Ausente/Noite/Custom)",
    ed_motion_entity: "Entidade de Movimento (Opcional - binary_sensor.* para o aviso de movimento sobre o vídeo)",
    ed_ring_entity: "Entidade de Campainha (Opcional - binary_sensor.* da campainha: ao tocar, a card liga o som sozinha)",
    ed_entity: "Entidade de Abertura/Relé (Opcional - se vazio com Device ID, usa-se a abertura nativa)", ed_duration: "Segundos para Fechar (1-20)", ed_height: "Altura do Cartão (Ex: 400px, 600px, auto)"
  },
  de: { // Alemán
    connecting: "Verbinde...", live: "Live", open: "Komm. offen", error_cam: "Fehler", no_lock: "Kein Schloss konfiguriert",
    motion_detected: "Bewegung erkannt", audio_active: "Audio aktiv", idle_status: "System im Ruhezustand", door_open_prefix: "Tür offen · Schließt in",
    lbl_mic_off: "Mikrofon", lbl_mic_on: "Aktiv", lbl_door_idle: "Tür", lbl_door_open: "Offen",
    talk_requesting: "Sprechrecht wird angefragt...", talk_denied_msg: "Sprachkanal von einem anderen Nutzer belegt", talk_busy: "Sprachkanal belegt",
    talk_taken: "Ein anderer Nutzer hat den Sprachkanal übernommen", talk_silence: "Die Türsprechanlage hat den Sprachkanal wegen Stille geschlossen",
    talk_legacy: "Diese Türsprechanlage bestätigt kein Sprechrecht (ältere Firmware)", lbl_mic_listen: "Zuhören", clients_tip: "Verbundene Clients",
    q_label: "Qualität", q_auto: "Auto", q_full: "Hoch", q_low: "Niedrig", q_audio_only: "Nur Audio",
    q_auto_loss: "Qualität automatisch angepasst: Paketverlust", q_auto_bw: "Qualität automatisch angepasst: zu wenig Bandbreite",
    q_auto_sub: "Die Türsprechanlage entscheidet", q_full_sub: "Volles Video", q_low_sub: "~1 Bild/s (nur Keyframes)", q_audio_only_sub: "Kein Video, nur Ton",
    q_low_warn: "Niedrige Qualität: ca. 1 Bild pro Sekunde. Kein Defekt.", talk_free_retry: "Sprachkanal frei — du kannst jetzt sprechen",
    fs_enter: "Vollbild", fs_exit: "Vollbild beenden",
    door_confirm: "Tür öffnen? Nochmal drücken", lbl_door_confirm: "Öffnen?",
    snd_on: "Stummschalten", snd_off: "Mithören", snd_ring: "Es klingelt — Ton an",
    door_opening: "Tür wird geöffnet...", lbl_door_opening: "Öffnet", door_no_answer: "Keine Antwort der Türsprechanlage — die Tür wurde NICHT geöffnet",
    conn_relay: "Lokaler Weg antwortet nicht · Verbindung über die Cloud", retry_prefix: "Keine Verbindung · neuer Versuch in",
    snd_blocked: "Auf den Lautsprecher tippen, um zu hören", cred_revoked: "Die Türsprechanlage hat diese Kopplung abgelehnt — in Einstellungen › Geräte & Dienste neu koppeln",
    ed_device_id: "Native IG Doorbell Device ID (empfohlen)",
    ed_mode_entity: "Modus-Entität (Optional - select.* für die Chips Normal/Abwesend/Nacht/Custom)",
    ed_motion_entity: "Bewegungs-Entität (Optional - binary_sensor.* für den Bewegungshinweis über dem Video)",
    ed_ring_entity: "Klingel-Entität (Optional - binary_sensor.* der Klingel: beim Läuten schaltet die Karte den Ton selbst ein)",
    ed_entity: "Türöffner/Relais Entität (Optional - leer mit Device ID nutzt native Öffnung)", ed_duration: "Auto-Schließen Sekunden (1-20)", ed_height: "Kartenhöhe (Bsp: 400px, 600px, auto)"
  },
  fr: { // Francés
    connecting: "Connexion...", live: "En direct", open: "Comms Ouvertes", error_cam: "Erreur", no_lock: "Aucune serrure configurée",
    motion_detected: "Mouvement détecté", audio_active: "Audio actif", idle_status: "Système au repos", door_open_prefix: "Porte ouverte · Fermeture dans",
    lbl_mic_off: "Microphone", lbl_mic_on: "Actif", lbl_door_idle: "Porte", lbl_door_open: "Ouverte",
    talk_requesting: "Demande de parole...", talk_denied_msg: "Canal vocal occupé par un autre utilisateur", talk_busy: "Canal vocal occupé",
    talk_taken: "Un autre utilisateur a pris le canal vocal", talk_silence: "Le portier a fermé le canal vocal après un silence",
    talk_legacy: "Ce portier ne confirme pas le tour de parole (firmware antérieur)", lbl_mic_listen: "Écoute", clients_tip: "Clients connectés",
    q_label: "Qualité", q_auto: "Auto", q_full: "Haute", q_low: "Basse", q_audio_only: "Audio seul",
    q_auto_loss: "Qualité ajustée automatiquement : perte de paquets", q_auto_bw: "Qualité ajustée automatiquement : bande passante insuffisante",
    q_auto_sub: "Le portier décide", q_full_sub: "Vidéo complète", q_low_sub: "~1 image/s (images clés)", q_audio_only_sub: "Pas de vidéo, son seul",
    q_low_warn: "Qualité basse : environ 1 image par seconde. Ce n'est pas une panne.", talk_free_retry: "Canal vocal libre — vous pouvez parler",
    fs_enter: "Plein écran", fs_exit: "Quitter le plein écran",
    door_confirm: "Ouvrir la porte ? Appuyez encore", lbl_door_confirm: "Ouvrir ?",
    snd_on: "Couper le son", snd_off: "Écouter", snd_ring: "On sonne — son activé",
    door_opening: "Ouverture de la porte...", lbl_door_opening: "Ouverture", door_no_answer: "Pas de réponse du portier — la porte n'a PAS été ouverte",
    conn_relay: "Le chemin local ne répond pas · connexion via le cloud", retry_prefix: "Pas de connexion · nouvel essai dans",
    snd_blocked: "Touchez le haut-parleur pour écouter", cred_revoked: "Le portier a refusé cet appairage — réappairez-le dans Paramètres › Appareils et services",
    ed_device_id: "Device ID natif IG Doorbell (recommandé)",
    ed_mode_entity: "Entité de Mode (Optionnel - select.* pour afficher les puces Normal/Absent/Nuit/Custom)",
    ed_motion_entity: "Entité de Mouvement (Optionnel - binary_sensor.* pour l'alerte de mouvement sur la vidéo)",
    ed_ring_entity: "Entité de Sonnette (Optionnel - binary_sensor.* de la sonnette : la carte active le son toute seule)",
    ed_entity: "Entité de déverrouillage/relais (Optionnel - vide avec Device ID = ouverture native)", ed_duration: "Secondes de fermeture auto (1-20)", ed_height: "Hauteur de la carte (Ex: 400px, 600px, auto)"
  },
  ru: { // Ruso
    connecting: "Подключение...", live: "В прямом эфире", open: "Связь открыта", error_cam: "Ошибка", no_lock: "Замок не настроен",
    motion_detected: "Обнаружено движение", audio_active: "Аудио активно", idle_status: "Система в режиме ожидания", door_open_prefix: "Дверь открыта · Закрытие через",
    lbl_mic_off: "Микрофон", lbl_mic_on: "Активен", lbl_door_idle: "Дверь", lbl_door_open: "Открыта",
    talk_requesting: "Запрос очереди...", talk_denied_msg: "Голосовой канал занят другим пользователем", talk_busy: "Голосовой канал занят",
    talk_taken: "Другой пользователь занял голосовой канал", talk_silence: "Домофон закрыл голосовой канал из-за тишины",
    talk_legacy: "Этот домофон не подтверждает очередь речи (старая прошивка)", lbl_mic_listen: "Прослушивание", clients_tip: "Подключенные клиенты",
    q_label: "Качество", q_auto: "Авто", q_full: "Высокое", q_low: "Низкое", q_audio_only: "Только звук",
    q_auto_loss: "Качество изменено автоматически: потеря пакетов", q_auto_bw: "Качество изменено автоматически: недостаточно полосы",
    q_auto_sub: "Решает домофон", q_full_sub: "Полное видео", q_low_sub: "~1 кадр/с (только ключевые)", q_audio_only_sub: "Без видео, только звук",
    q_low_warn: "Низкое качество: около 1 кадра в секунду. Это не неисправность.", talk_free_retry: "Голосовой канал свободен — можно говорить",
    fs_enter: "Полный экран", fs_exit: "Выйти из полного экрана",
    door_confirm: "Открыть дверь? Нажмите ещё раз", lbl_door_confirm: "Открыть?",
    snd_on: "Выключить звук", snd_off: "Слушать", snd_ring: "Звонят — звук включён",
    door_opening: "Открывание двери...", lbl_door_opening: "Открывание", door_no_answer: "Домофон не ответил — дверь НЕ открыта",
    conn_relay: "Локальный путь не отвечает · подключение через облако", retry_prefix: "Нет связи · повтор через",
    snd_blocked: "Коснитесь динамика, чтобы слышать", cred_revoked: "Домофон отклонил эту привязку — выполните привязку заново в Настройки › Устройства и службы",
    ed_device_id: "Собственный Device ID IG Doorbell (рекомендуется)",
    ed_mode_entity: "Объект режима (Необязательно - select.* для чипов Обычный/Отсутствие/Ночь/Custom)",
    ed_motion_entity: "Объект движения (Необязательно - binary_sensor.* для значка движения поверх видео)",
    ed_ring_entity: "Объект звонка (Необязательно - binary_sensor.* звонка: при звонке карточка сама включает звук)",
    ed_entity: "Объект отпирания/реле (Необязательно - если пусто при Device ID, используется нативное открытие)", ed_duration: "Секунды авто-закрытия (1-20)", ed_height: "Высота карточки (Напр: 400px, 600px, auto)"
  },
  zh: { // Chino Mandarín
    connecting: "连接中...", live: "直播中", open: "通话中", error_cam: "错误", no_lock: "未配置门锁",
    motion_detected: "检测到移动", audio_active: "音频已激活", idle_status: "系统待机", door_open_prefix: "门已开 · 关闭倒计时",
    lbl_mic_off: "麦克风", lbl_mic_on: "已激活", lbl_door_idle: "门", lbl_door_open: "已开",
    talk_requesting: "正在请求发言权...", talk_denied_msg: "语音通道被其他用户占用", talk_busy: "语音通道占用中",
    talk_taken: "其他用户已接管语音通道", talk_silence: "门口机因静音已关闭语音通道",
    talk_legacy: "该门口机不确认发言权（旧固件）", lbl_mic_listen: "收听中", clients_tip: "已连接客户端",
    q_label: "画质", q_auto: "自动", q_full: "高", q_low: "低", q_audio_only: "仅音频",
    q_auto_loss: "画质已自动调整：丢包", q_auto_bw: "画质已自动调整：带宽不足",
    q_auto_sub: "由门口机决定", q_full_sub: "完整视频", q_low_sub: "约1帧/秒（仅关键帧）", q_audio_only_sub: "无视频，仅声音",
    q_low_warn: "低画质：约每秒1帧，这不是故障。", talk_free_retry: "语音通道已空闲 — 现在可以讲话",
    fs_enter: "全屏", fs_exit: "退出全屏",
    door_confirm: "确定开门？再按一次", lbl_door_confirm: "开门？",
    snd_on: "静音", snd_off: "收听", snd_ring: "有人按门铃 — 已开启声音",
    door_opening: "正在开门...", lbl_door_opening: "开门中", door_no_answer: "门口机没有响应 — 门并未打开",
    conn_relay: "本地通道无响应 · 正在通过云端连接", retry_prefix: "无连接 · 重试倒计时",
    snd_blocked: "点击扬声器以收听", cred_revoked: "门口机拒绝了此配对 — 请在 设置 › 设备与服务 中重新配对",
    ed_device_id: "原生 IG Doorbell 设备 ID (推荐)",
    ed_mode_entity: "模式实体 (可选 - select.* 用于显示 正常/离开/夜间/自定义 标签)",
    ed_motion_entity: "移动实体 (可选 - binary_sensor.* 用于视频上的移动提示)",
    ed_ring_entity: "门铃实体 (可选 - binary_sensor.* 门铃：响铃时卡片自动开启声音)",
    ed_entity: "解锁/继电器实体 (可选 - 留空且有设备ID时使用原生开门)", ed_duration: "自动关闭秒数 (1-20)", ed_height: "卡片高度 (例: 400px, 600px, auto)"
  },
  hi: { // Hindi
    connecting: "कनेक्ट हो रहा है...", live: "लाइव", open: "संचार चालू", error_cam: "त्रुटि", no_lock: "कोई लॉक कॉन्फ़िगर नहीं",
    motion_detected: "गति का पता चला", audio_active: "ऑडियो सक्रिय", idle_status: "सिस्टम निष्क्रिय", door_open_prefix: "दरवाज़ा खुला · बंद हो रहा है",
    lbl_mic_off: "माइक्रोफ़ोन", lbl_mic_on: "सक्रिय", lbl_door_idle: "दरवाज़ा", lbl_door_open: "खुला",
    talk_requesting: "बोलने की बारी मांगी जा रही है...", talk_denied_msg: "वॉइस चैनल किसी अन्य उपयोगकर्ता के पास है", talk_busy: "वॉइस चैनल व्यस्त",
    talk_taken: "किसी अन्य उपयोगकर्ता ने वॉइस चैनल ले लिया", talk_silence: "खामोशी के कारण डोरबेल ने वॉइस चैनल बंद कर दिया",
    talk_legacy: "यह डोरबेल बोलने की बारी की पुष्टि नहीं करता (पुराना फर्मवेयर)", lbl_mic_listen: "सुन रहे हैं", clients_tip: "जुड़े क्लाइंट",
    q_label: "गुणवत्ता", q_auto: "ऑटो", q_full: "उच्च", q_low: "निम्न", q_audio_only: "केवल ऑडियो",
    q_auto_loss: "गुणवत्ता स्वतः समायोजित: पैकेट हानि", q_auto_bw: "गुणवत्ता स्वतः समायोजित: अपर्याप्त बैंडविड्थ",
    q_auto_sub: "डोरबेल तय करता है", q_full_sub: "पूरा वीडियो", q_low_sub: "~1 फ्रेम/सेकंड (केवल कीफ्रेम)", q_audio_only_sub: "वीडियो नहीं, केवल ध्वनि",
    q_low_warn: "कम गुणवत्ता: लगभग 1 फ्रेम प्रति सेकंड। यह खराबी नहीं है।", talk_free_retry: "वॉइस चैनल खाली — अब आप बोल सकते हैं",
    fs_enter: "पूर्ण स्क्रीन", fs_exit: "पूर्ण स्क्रीन से बाहर",
    door_confirm: "दरवाज़ा खोलें? फिर से दबाएँ", lbl_door_confirm: "खोलें?",
    snd_on: "म्यूट करें", snd_off: "सुनें", snd_ring: "कोई घंटी बजा रहा है — ध्वनि चालू",
    door_opening: "दरवाज़ा खोला जा रहा है...", lbl_door_opening: "खुल रहा है", door_no_answer: "डोरबेल ने जवाब नहीं दिया — दरवाज़ा नहीं खुला",
    conn_relay: "लोकल रास्ता जवाब नहीं दे रहा · क्लाउड से जुड़ रहे हैं", retry_prefix: "कनेक्शन नहीं · फिर कोशिश",
    snd_blocked: "सुनने के लिए स्पीकर पर टैप करें", cred_revoked: "डोरबेल ने यह पेयरिंग अस्वीकार कर दी — सेटिंग्स › डिवाइस और सेवाएँ में दोबारा पेयर करें",
    ed_device_id: "नेटिव IG Doorbell डिवाइस ID (अनुशंसित)",
    ed_mode_entity: "मोड एंटिटी (वैकल्पिक - select.* सामान्य/अनुपस्थित/रात/कस्टम चिप्स दिखाने के लिए)",
    ed_motion_entity: "मोशन एंटिटी (वैकल्पिक - binary_sensor.* वीडियो पर मोशन बैज के लिए)",
    ed_ring_entity: "डोरबेल एंटिटी (वैकल्पिक - binary_sensor.* घंटी: बजने पर कार्ड स्वयं ध्वनि चालू करता है)",
    ed_entity: "अनलॉक/रिले एंटिटी (वैकल्पिक - खाली और Device ID होने पर नेटिव ओपन उपयोग होगा)", ed_duration: "ऑटो-क्लोज़ सेकंड (1-20)", ed_height: "कार्ड की ऊंचाई (उदा: 400px, 600px, auto)"
  },
  ar: { // Árabe
    connecting: "جارٍ الاتصال...", live: "مباشر", open: "اتصال مفتوح", error_cam: "خطأ", no_lock: "لا يوجد قفل مُهيأ",
    motion_detected: "تم اكتشاف حركة", audio_active: "الصوت نشط", idle_status: "النظام في وضع الخمول", door_open_prefix: "الباب مفتوح · يُغلق خلال",
    lbl_mic_off: "الميكروفون", lbl_mic_on: "نشط", lbl_door_idle: "الباب", lbl_door_open: "مفتوح",
    talk_requesting: "جارٍ طلب الدور...", talk_denied_msg: "قناة الصوت مشغولة بمستخدم آخر", talk_busy: "قناة الصوت مشغولة",
    talk_taken: "استحوذ مستخدم آخر على قناة الصوت", talk_silence: "أغلق الجهاز قناة الصوت بسبب الصمت",
    talk_legacy: "هذا الجهاز لا يؤكد دور التحدث (إصدار سابق)", lbl_mic_listen: "استماع", clients_tip: "العملاء المتصلون",
    q_label: "الجودة", q_auto: "تلقائي", q_full: "عالية", q_low: "منخفضة", q_audio_only: "صوت فقط",
    q_auto_loss: "تم ضبط الجودة تلقائياً: فقد الحزم", q_auto_bw: "تم ضبط الجودة تلقائياً: عرض نطاق غير كافٍ",
    q_auto_sub: "الجهاز يقرر", q_full_sub: "فيديو كامل", q_low_sub: "~إطار واحد/ث (إطارات مفتاحية فقط)", q_audio_only_sub: "بدون فيديو، صوت فقط",
    q_low_warn: "جودة منخفضة: إطار واحد تقريباً في الثانية. ليس عطلاً.", talk_free_retry: "قناة الصوت متاحة — يمكنك التحدث الآن",
    fs_enter: "ملء الشاشة", fs_exit: "إنهاء ملء الشاشة",
    door_confirm: "هل تفتح الباب؟ اضغط مرة أخرى", lbl_door_confirm: "فتح؟",
    snd_on: "كتم الصوت", snd_off: "استماع", snd_ring: "هناك من يطرق — تم تشغيل الصوت",
    door_opening: "جارٍ فتح الباب...", lbl_door_opening: "جارٍ الفتح", door_no_answer: "لا رد من الجهاز — لم يُفتح الباب",
    conn_relay: "المسار المحلي لا يستجيب · الاتصال عبر السحابة", retry_prefix: "لا يوجد اتصال · إعادة المحاولة خلال",
    snd_blocked: "المس مكبر الصوت للاستماع", cred_revoked: "رفض الجهاز هذا الاقتران — أعد الاقتران من الإعدادات › الأجهزة والخدمات",
    ed_device_id: "معرّف الجهاز الأصلي IG Doorbell (موصى به)",
    ed_mode_entity: "كيان الوضع (اختياري - select.* لعرض رقائق عادي/غائب/ليلي/مخصص)",
    ed_motion_entity: "كيان الحركة (اختياري - binary_sensor.* لشارة الحركة فوق الفيديو)",
    ed_ring_entity: "كيان الجرس (اختياري - binary_sensor.* للجرس: عند الرنين تشغّل البطاقة الصوت تلقائياً)",
    ed_entity: "كيان الفتح/المُرحِّل (اختياري - إذا تُرك فارغاً مع Device ID يُستخدم الفتح الأصلي)", ed_duration: "ثواني الإغلاق التلقائي (1-20)", ed_height: "ارتفاع البطاقة (مثال: 400px، 600px، auto)"
  }
};

function getLocalText(hass, key) {
  // 1. Si no hay idioma configurado en HA, asumimos inglés ('en')
  const lang = (hass && hass.language) ? hass.language.substring(0, 2) : 'en';

  // 2. Si el idioma detectado NO existe en nuestro diccionario, forzamos inglés ('en')
  const table = igLocales[lang] || igLocales.en;
  // 3. Respaldo POR CLAVE, no solo por idioma (2026-07-26): antes, una clave presente en 'en'
  //    pero olvidada en otro idioma devolvia `undefined` y se pintaba literalmente "undefined" en
  //    la UI. Con 15 claves nuevas x 9 idiomas en este mismo cambio (multicliente/calidad), el
  //    riesgo real de que a alguien se le escape una en el futuro deja de ser teorico - mejor un
  //    texto en ingles que un "undefined" en pantalla.
  return (table[key] !== undefined) ? table[key] : igLocales.en[key];
}

// ==============================================================================
// PANTALLA COMPLETA. Dos niveles, y el motivo de que sean dos no es
// defensivo "por si acaso": es que la API real del navegador NO esta disponible en una parte
// grande de donde se usa esta card, y esta comprobado de donde viene cada caso.
//
// Nivel 1 - API nativa del navegador (Fullscreen API). Es la buena: oculta ademas la barra de
// direcciones/las barras del sistema, y trae la salida con ESC ya hecha por el navegador.
//
// Nivel 2 - respaldo propio en CSS (position:fixed ocupando el viewport entero). Se usa donde el
// nivel 1 no existe. NO oculta las barras del sistema del movil - ocupa toda la ventana de la
// aplicacion, que en la app companion es casi toda la pantalla.
//
// POR QUE HACE FALTA EL NIVEL 2, con las dos causas reales (verificadas en el codigo fuente de
// los proyectos implicados, no deducidas de un foro):
//
//   * App companion de ANDROID: la web va dentro de un WebView. Chromium solo concede la
//     Fullscreen API si la aplicacion anfitriona implementa `WebChromeClient.onShowCustomView`;
//     si no lo hace, `document.fullscreenEnabled` devuelve false POR DISENO (chromium:
//     `android_webview/browser/aw_settings.cc` rellena `web_prefs->fullscreen_supported` con ese
//     dato, y Blink lo consulta en `Fullscreen::FullscreenEnabled`). La app de Home Assistant
//     para Android no lo implementaba: lo anadio el 2026-05-06 (PR home-assistant/android#6790,
//     `HAWebChromeClient.kt`). Es decir, este caso se arregla solo actualizando la app - pero
//     quien tenga una version anterior sigue sin API.
//
//   * App companion de iOS: `WKWebView` trae la pantalla completa de elementos APAGADA de
//     fabrica; hay que encenderla con `WKPreferences.isElementFullscreenEnabled` (iOS 15.4+). La
//     app de Home Assistant para iOS no la toca (`WebViewController.swift`,
//     `makeWebViewConfiguration()`), asi que se queda apagada. Aqui no hay version que lo
//     arregle desde nuestro lado. Ademas, en un iPhone tampoco hay pantalla completa de
//     elementos ni en Safari - es una limitacion de WebKit en ese formato, no de la app.
//
// Lo que hace Advanced Camera Card (que es la card que el usuario cita como referencia): usa la
// libreria `screenfull`, que es exactamente esta misma deteccion, y cuando no hay API cae a
// `video.webkitEnterFullscreen()` - el reproductor nativo de iOS. Ese respaldo no nos sirve:
// se lleva el elemento <video> a un reproductor del sistema y **desaparecen los botones de la
// card**, que es justo lo que este modo tiene que ofrecer (micro y abrir puerta). De ahi que el
// nivel 2 sea propio y en CSS, conservando nuestro HUD.
//
// Consecuencia de diseno: el icono de pantalla completa NUNCA es un icono muerto. Siempre hay un
// camino real; solo cambia cual. Ver _enterFullscreen().
// ==============================================================================
function nativeFullscreenAvailable() {
  // `document.fullscreenEnabled` es la comprobacion del estandar y contempla tanto que el motor
  // lo soporte como que el contexto tenga permiso (p.ej. un <iframe> sin `allowfullscreen`
  // devuelve false, que es la respuesta correcta). Se mira tambien la variante con prefijo por
  // los WebKit antiguos.
  const enabled = (document.fullscreenEnabled !== undefined)
    ? document.fullscreenEnabled
    : (document.webkitFullscreenEnabled === true);
  const proto = (typeof Element !== 'undefined') ? Element.prototype : null;
  const canRequest = !!(proto && (proto.requestFullscreen || proto.webkitRequestFullscreen));
  return !!enabled && canRequest;
}

function currentFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

// ==============================================================================
// MULTICLIENTE / CALIDAD (contrato de señalización 2026-07-26, API_CONTRACT.md §1.4-ter):
// turno de palabra, contador de clientes y calidad por destinatario. Los tres viajan por el
// MISMO canal de señalización que ya usaba la card (SSE+POST local / WS del relay remoto), sin
// ningun endpoint ni transporte nuevo - ver handleNativeSignal() mas abajo.
//
// Modos de calidad, en el orden exacto en que se pintan en el selector sobre el video. `wire` es
// el valor literal del campo `mode` del JSON; `key` es la clave de traduccion. `expectsVideo`
// existe para un motivo real y no cosmetico: en 'audio_only' el dispositivo NO manda ni un
// paquete de video a este cliente, asi que el vigilante de vida (que mide progreso de
// packetsReceived del INBOUND-RTP DE VIDEO) interpretaria ese silencio esperado como una sesion
// muerta y reconectaria en bucle cada 20s. Ver _checkLifeWatchdog().
// Cada modo lleva ADEMAS una linea explicativa (`sub`) que se pinta bajo su nombre en el menu -
// paridad con la app Android, y por un motivo concreto: "Baja" NO es video fluido de menos
// calidad, es ~1 imagen por segundo (el dispositivo manda solo keyframes, §1.4-ter). Sin
// explicarlo, un usuario que lo active pensara que el aparato se ha averiado. Por lo mismo se
// evitan a proposito etiquetas tipo HD/SD: sugieren un cambio de RESOLUCION cuando lo que cambia
// es la CADENCIA.
const QUALITY_MODES = [
  { wire: 'auto', key: 'q_auto', sub: 'q_auto_sub', icon: 'mdi:auto-fix', expectsVideo: true },
  { wire: 'full', key: 'q_full', sub: 'q_full_sub', icon: 'mdi:video', expectsVideo: true },
  { wire: 'low', key: 'q_low', sub: 'q_low_sub', icon: 'mdi:image-filter-tilt-shift', expectsVideo: true },
  { wire: 'audio_only', key: 'q_audio_only', sub: 'q_audio_only_sub', icon: 'mdi:volume-high', expectsVideo: false },
];

function qualityModeMeta(wire) {
  return QUALITY_MODES.find((m) => m.wire === wire) || null;
}

// Chips de modo (2026-07-10, ver COORDINATION.md Q22-bis en ig_hassio_addons) - mismo
// icono por modo que el mockup real de Figma (el tintado/borde de cada modo activo vive en
// injectStyles(), reglas `.chip.active.mode-<key>` - esta tabla solo mapea la ETIQUETA de cada
// opcion a un icono conocido). La entidad `select.*` configurada en `mode_entity` es la fuente
// de verdad (opciones reales + estado actual) - una opcion que no matchee ningun patron se
// pinta igualmente (chip generico sin tintar), nunca oculta la fila entera.
const MODE_META = {
  normal: { icon: 'mdi:home-outline' },
  away: { icon: 'mdi:logout' },
  night: { icon: 'mdi:weather-night' },
  custom: { icon: 'mdi:tune' }, // mdi:tune-variant no existe en el set real de Material Design Icons
};

class IgDoorbellCard extends HTMLElement {
  static async getConfigElement() {
    return document.createElement('ig-doorbell-card-editor');
  }

  static getStubConfig() {
    return { height: "auto", unlock_duration: 3 };
  }

  set hass(hass) {
    this._hass = hass;
    // Chips de modo / chip de movimiento (2026-07-10, ver COORDINATION.md Q22-bis) se leen de
    // entidades reales de HA configurables (mode_entity/motion_entity) - hass se reasigna en
    // cada tick de estado de HA (puede ser muy frecuente), asi que _updateHassBoundUI() hace su
    // propia comparacion barata antes de tocar el DOM.
    this._updateHassBoundUI();
  }

  setConfig(config) {
    if (!config.device_id) {
      throw new Error('Debes definir "device_id" (ver Ajustes > Dispositivos y servicios > IG Doorbell)');
    }
    // Bug real encontrado y corregido (2026-07-10, ver COORDINATION.md - reporte del usuario: al
    // ajustar el ancho de la card, la card crece pero el video se queda al mismo tamaño de
    // siempre). Causa: esta card NO usa Shadow DOM (this.innerHTML directo sobre el propio
    // elemento, DOM "ligero") y el elemento personalizado en si (<ig-doorbell-card>) no
    // tenia NUNCA un display/width propios declarados. Los Custom Elements autonomos son
    // `display: inline` por defecto salvo que se declare lo contrario (ni el navegador ni HA lo
    // hacen automaticamente por ti) - un elemento inline se dimensiona a su CONTENIDO, no al
    // ancho disponible del contenedor que lo aloja. Todo el CSS interno (.ig-container,
    // .video-wrapper, video { width:100% }) SI era correcto y relativo, pero "100%" de un
    // elemento inline sin ancho propio se resuelve al ancho intrinseco del contenido, no al
    // hueco que HA le da (p.ej. al ajustar el ancho en un dashboard de tipo "Secciones"). Fijado
    // en JS (no solo en la hoja de estilos inyectada mas abajo, ver injectStyles) para que se
    // aplique de inmediato, antes de que exista ningun hijo que pueda depender de el.
    this.style.display = 'block';
    this.style.width = '100%';
    this.style.boxSizing = 'border-box';
    this.config = config;
    // ⚠️ SOLTAR LA PANTALLA CUANDO YA NADIE MIRA (2026-09-06, pedido por Inaki).
    //
    // Mientras hay video la card pide un wake lock para que la pantalla no se atenue a mitad de
    // conversacion. En un TELEFONO eso dura lo que dura la llamada. En un PANEL DE PARED no: la
    // pantalla se quedaba encendida indefinidamente despues de un timbrazo, y el wake lock ademas
    // GANABA a `command_screen_off` de Home Assistant. Un pez que se muerde la cola -- medido en la
    // Galaxy Tab del salon: para soltar el stream hay que ocultar la card, y el wake lock no dejaba
    // apagar la pantalla para ocultarla.
    //
    // A los `idle_release_seconds` sin que nadie toque, se suelta el lock. Entonces el sistema apaga
    // la pantalla por su propio tiempo de espera, la card queda oculta, y el arreglo de la v1.3.0
    // cierra el WebRTC. Se recupera en cuanto alguien toca, asi que mirar o hablar no se interrumpe.
    //
    // `0` lo desactiva -- para un telefono, donde este problema no existe y soltar la pantalla a
    // mitad de conversacion seria un fallo, no un ahorro.
    const idleCrudo = Number(config.idle_release_seconds);
    this._idleReleaseMs = Number.isFinite(idleCrudo) && idleCrudo >= 0 ? idleCrudo * 1000 : 60000;

    // Modo go2rtc/gateway legacy RETIRADO por completo (2026-07-10, decision explicita del
    // usuario - ver COORDINATION.md en ig_hassio_addons): el proyecto habla WebRTC nativo
    // directo con el dispositivo/relay, nunca go2rtc - mantener esa rama muerta solo anadia
    // confusion. Unico modo soportado ahora: nativo (protocolo propio del doorbell,
    // ICE-Lite+DTLS-SRTP+RTP, via la integracion ig_doorbell).

    this.talkActive = false;
    this.pc = null;
    this.nativeSSE = null;
    this.nativeWS = null;
    this._slot = null;
    this.localAudioStream = null;
    this.dummyAudioTrack = null;

    // Vigilante de "señales de vida" + reconexión automática (2026-07-10, ver COORDINATION.md
    // Q19 - diseño simétrico con el timeout de abandono del propio firmware, bajado de 45s a
    // 20s). Solo aplica al modo nativo, ver _startLifeWatchdog()/_checkLifeWatchdog() más abajo.
    this._watchdogTimer = null;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._reconnecting = false;
    this._lastLifeSignalAt = null;
    this._prevPacketsReceived = null;

    // ---- Multicliente / calidad (2026-07-26, API_CONTRACT.md §1.4-ter) ----------------------
    // Todo esto se resetea ademas en _resetMulticlientState() en cada teardown/sesion nueva: el
    // turno de palabra y la calidad son estado POR SESION en el dispositivo (una sesion nueva
    // arranca siempre en 'full' y sin turno), asi que la card no debe heredar nada de la anterior.
    this._talkHeld = false;       // el dispositivo nos concedio el turno (talk_granted)
    this._talkPending = false;    // hay un talk_request en vuelo
    this._talkTimer = null;
    this._talkGrantedAt = 0;      // para la gracia anti-revocacion-de-carrera, ver _reconcileTalkTurn
    this._talkUnsupported = false; // firmware anterior al contrato: no contesta a talk_request
    this._listenOnly = false;     // turno denegado: se oye al portero pero el micro sigue cerrado
    this._talkFreeHintShown = false; // ya se aviso de "canal libre" en esta espera concreta
    this._talkerSlot = -1;        // slot que tiene el turno segun el dispositivo (-1 = libre)
    this._clients = null;         // null = el dispositivo nunca mando session_info (firmware viejo)
    this._quality = 'auto';       // modo pedido por esta card
    this._qualityEffective = null; // modo CONFIRMADO por el dispositivo (unica fuente de verdad)
    this._qualitySupported = null; // null = sin confirmar todavia; false = firmware sin calidad
    this._qualityProbeTimer = null;
    this._qualityProbeAttempts = 0;
    this._qualityMenuOpen = false;

    // ---- Pantalla completa (2026-07-29) -----------------------------------------------------
    // A diferencia del bloque de arriba, esto NO es estado por sesion: es una preferencia de
    // visualizacion del usuario y sobrevive a una reconexion (seria absurdo que un corte de red
    // de dos segundos te sacara de la pantalla completa mientras hablas con quien esta en la
    // puerta). Por eso no se toca en _resetMulticlientState().
    this._fsActive = false;
    this._fsNative = false;      // true = pantalla completa real del navegador; false = respaldo CSS
    this._fsUnavailable = false; // ni API nativa ni respaldo utilizable: el icono se esconde
    this._wakeLock = null;

    // Tipo de cerradura del portero: 0 = rele fisico, 1 = entidad de Home Assistant, 2 = ninguna.
    // Con 2, el boton de abrir NO debe dibujarse, en vez de dibujarse y fallar.
    //
    // El dato llega en CADA `session_info` (2026-07-29), no solo en el primero, y eso permite dos
    // cosas: si un aviso se pierde -- se descartan cuando la cola de salida esta llena -- el
    // siguiente reconstruye el dato; y si alguien cambia el tipo de cerradura desde el dashboard
    // del portero con esta card abierta, se refleja en <=4s en vez de arrastrar un boton
    // equivocado hasta la siguiente reconexion.
    //
    // `null` = todavia no lo ha dicho (o firmware anterior, que no manda el campo). En ese caso, y
    // SOLO en ese caso, sigue valiendo la red de seguridad de aprenderlo fallando: ver
    // _noLockLegacy y handleNativeOpenResult(). Un `door_m` recibido manda siempre sobre ella.
    this._doorMode = null;
    this._noLockLegacy = false;

    // ---- Doble pulsacion para abrir (API_CONTRACT.md §1.8, 2026-07-30) ----------------------
    // No es configurable a proposito (lo dice el contrato): un mecanismo de seguridad que se puede
    // desactivar deja de serlo.
    this._doorArmedAt = 0;
    this._doorArmTimer = null;

    // ---- Sonido del cliente (API_CONTRACT.md §1.10, 2026-07-30) -----------------------------
    // VER NO ES ESCUCHAR: el altavoz de ESTE lado arranca MUDO y solo suena por un motivo
    // explicito (el usuario lo abre, o alguien llama al timbre). Un panel de pared que enseña la
    // calle 24h no puede meter el ruido de la calle en casa 24h.
    //
    // No se pide al portero que deje de mandar audio (eso seria `quality`, §1.4-ter, y ahorraria
    // ~24 kbps que al lado del video son ruido estadistico): simplemente no se reproduce.
    this._audioOn = false;
    this._audioOnBeforeMic = false;  // para devolver el sonido a como estaba al cerrar el micro
    this._ringMarker = null;         // ultimo estado leido de ring_entity (null = aun sin leer)

    // ---- Giro de la imagen (API_CONTRACT.md §1.9, 2026-07-30) -------------------------------
    // El modulo de camara va montado GIRADO 90° dentro de la carcasa, a proposito: en vertical
    // caben una persona entera y un paquete en el suelo. Rotar en el propio portero se midio en
    // 65-71 ms por frame, con el presupuesto entero de 15 fps en 66,7 ms - inviable. Asi que el
    // frame viaja apaisado con la escena girada dentro y lo endereza CADA CLIENTE al pintarlo,
    // que es gratis en cualquier plataforma.
    //
    // El dato llega en `rot` dentro de CADA `session_info` (§1.4-ter), como `door_m`.
    //
    // Se recuerda el ultimo valor conocido de ESTE portero (localStorage) para no reservar el
    // hueco equivocado y saltar de forma a la vista en cada arranque, que es el defecto que Iñaki
    // vio en iOS. La primera vez, sin dato guardado, se reserva VERTICAL: es el montaje del
    // producto, y equivocarse hacia el caso raro es mejor que equivocarse siempre.
    this._rot = this._recallRotation();
    this._rotConfirmed = false;

    this.render();
  }

  getCardSize() { return 4; }

  connectedCallback() {
    if (this.content) this._registerFullscreenListeners();
    this._registerVisibilityStreamHandler();
    if (this.content && !this.pc) this.startWebRTC();
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  SOLTAR EL STREAM AL OCULTARSE (2026-09-06)
  //
  //  disconnectedCallback() ya desmontaba la conexion y soltaba el wake lock. El problema no era
  //  que faltara ese codigo: era que NADIE LO LLAMABA en los casos que importan. Medido en la
  //  tablet del salon (Galaxy Tab, wallpanel) por la sesion de HASS de casa:
  //
  //    · navegar a otra vista de Lovelace NO corta el WebRTC -- la SPA no retira la card del DOM,
  //      asi que disconnectedCallback() no se dispara;
  //    · `command_webview` a about:blank tampoco lo corta;
  //    · cada navegacion ABRE una conexion nueva sin cerrar la anterior (espectadores 1 -> 3);
  //    · lo unico que lo cortaba era `am force-stop` de la app de Home Assistant.
  //
  //  Consecuencia real: la tablet se quedaba con la pantalla encendida y consumiendo video
  //  INDEFINIDAMENTE, porque el stream retiene el wakelock de brillo. Y ademas gastaba plazas del
  //  portero, que solo tiene 4 para toda la casa.
  //
  //  `visibilitychange` es el disparador que si llega en todos esos casos: pantalla apagada, app
  //  al fondo, y tambien cuando la vista deja de estar delante. Ojo -- NO es el mismo manejador
  //  que `_onVisibilityForWakeLock`: aquel solo REPONE el wake lock al volver a ser visible, y no
  //  hace nada al ocultarse, que es justo la mitad que faltaba.
  // ══════════════════════════════════════════════════════════════════════════════════════════
  _registerVisibilityStreamHandler() {
    if (this._onVisibilityForStream) return;
    this._onVisibilityForStream = () => {
      if (document.visibilityState === 'hidden') {
        if (!this.pc && !this._reconnecting) return;   // no habia nada que soltar
        // Se recuerda que habia stream para poder reponerlo: sin esto, volver a mirar la tablet
        // dejaria la card muda y con el video negro, que es peor que el problema que arregla.
        this._streamPausedByHide = true;
        this._clearReconnectTimer();
        this._reconnecting = false;
        this._teardownConnectionObjects();
        this._releaseWakeLock();
        if (this.micButton) this._setLiveState('connecting');
        if (this.loader) this.loader.style.opacity = '1';
      } else if (document.visibilityState === 'visible' && this._streamPausedByHide) {
        this._streamPausedByHide = false;
        // `isConnected` y no un booleano propio: si la card ya no esta en el DOM, reconectar
        // crearia exactamente el cliente zombi que esto viene a evitar.
        if (this.isConnected && this.content && !this.pc) this.startWebRTC();
      }
    };
    document.addEventListener('visibilitychange', this._onVisibilityForStream);
  }

  _unregisterVisibilityStreamHandler() {
    if (!this._onVisibilityForStream) return;
    document.removeEventListener('visibilitychange', this._onVisibilityForStream);
    this._onVisibilityForStream = null;
    this._streamPausedByHide = false;
  }

  disconnectedCallback() {
    this._unregisterUnloadHandler();
    this._unregisterVisibilityStreamHandler();
    this._unregisterIdleActivityListeners();
    this._clearIdleWakeLockTimer();
    this._clearReconnectTimer();
    this._reconnecting = false;
    this._teardownConnectionObjects();
    if (this.micButton) {
      this._setLiveState('connecting');
    }
    if (this.loader) this.loader.style.opacity = '1';
    if (this._hudClockTimer) { clearInterval(this._hudClockTimer); this._hudClockTimer = null; }
    if (this._doorArmTimer) { clearTimeout(this._doorArmTimer); this._doorArmTimer = null; }
    this._doorArmedAt = 0;
    this._stopRetryCountdown();
    if (this._doorWaitTimer) { clearTimeout(this._doorWaitTimer); this._doorWaitTimer = null; }
    if (this._doorCountdownTimer) { clearInterval(this._doorCountdownTimer); this._doorCountdownTimer = null; }
    if (this._feedRO) { this._feedRO.disconnect(); this._feedRO = null; }
    if (this._onWindowResizeForRot) {
      window.removeEventListener('resize', this._onWindowResizeForRot);
      this._onWindowResizeForRot = null;
    }
    if (this._onDocClickForQuality) {
      document.removeEventListener('click', this._onDocClickForQuality);
      this._onDocClickForQuality = null;
    }
    // Pantalla completa: salir SIEMPRE al desaparecer la card del DOM (cambio de vista de
    // Lovelace, edicion del dashboard...). Sin esto, el respaldo CSS dejaria el `scroll` del
    // documento bloqueado y el usuario se quedaria con un dashboard que no se mueve, sin ninguna
    // card visible a la que culpar; y el wake lock seguiria vivo consumiendo bateria.
    if (this._fsActive) this._exitFullscreen();
    this._releaseWakeLock();
    document.body.classList.remove('ig-fs-body-lock');
    if (this._onFsChange) {
      document.removeEventListener('fullscreenchange', this._onFsChange);
      document.removeEventListener('webkitfullscreenchange', this._onFsChange);
      this._onFsChange = null;
    }
    if (this._onFsKeyDown) {
      document.removeEventListener('keydown', this._onFsKeyDown);
      this._onFsKeyDown = null;
    }
  }

  // ==============================================================================
  // Limpieza compartida de la conexion nativa (2026-07-10, ver COORDINATION.md Q18/Q19).
  // Cierra pc/nativeSSE/nativeWS, manda 'bye' antes de cerrar cuando aplica, resetea el slot y
  // para el vigilante de vida - usado tanto por disconnectedCallback() (la card sale del DOM)
  // como por _scheduleReconnect() (la sesion se dio por muerta y hay que reconectar). Extraido
  // a un solo sitio para no duplicar la logica de cierre entre ambos casos.
  // ==============================================================================
  _teardownConnectionObjects() {
    this._stopLifeWatchdog();
    this._stopAudioSendDiagnostics();
    // Si el micro estaba abierto, el sonido se encendio POR EL MICRO - al cerrarse hay que
    // devolverlo a como estaba antes (§1.10). Se calcula aqui arriba porque _resetMulticlientState()
    // (mas abajo) borra _listenOnly.
    const micWasOpen = this.talkActive || this._listenOnly;
    // Bug real encontrado y corregido (2026-07-10, ver COORDINATION.md - sospecha del usuario
    // sobre el canal de retorno de audio): esta funcion es el UNICO punto de cierre compartido
    // por disconnectedCallback(), startWebRTC() y _scheduleReconnect() - pero hasta ahora solo
    // cerraba pc/nativeSSE/nativeWS, sin tocar el estado del interfono. Efecto real: si el mic
    // estaba activo (replaceTrack() ya habia puesto la pista real del microfono en el sender) y
    // llegaba una reconexion (p.ej. el atajo agresivo 'disconnected'->reconectar de mas abajo,
    // que puede disparar por un corte transitorio de ICE sin que el usuario haga nada), el nuevo
    // RTCPeerConnection se construye desde cero con una pista MUDA nueva (buildNativePeerConnection())
    // - pero como intercomActive/las clases del boton nunca se reseteaban aqui, la UI seguia
    // mostrando "mic activo" (icono rojo, badge 'Comms Abiertas') indefinidamente aunque el audio
    // saliente real hubiera vuelto a ser silencio, sin que toggleIntercom() se volviera a llamar
    // nunca para reenganchar el microfono real al nuevo sender. Ademas dejaba el dispositivo de
    // microfono del navegador "en uso" (icono del SO) sin ningun uso real. Se cierra centralizando
    // el reset aqui: cualquier teardown (voluntario o por reconexion) para el stream real y vuelve
    // el boton a estado "apagado" - un reconecto exitoso posterior no reactiva el mic solo (el
    // usuario tiene que volver a pulsar, igual que la primera vez - comportamiento explicito, no
    // silencioso).
    if (this.localAudioStream) {
      this.localAudioStream.getTracks().forEach((track) => track.stop());
      this.localAudioStream = null;
    }
    this.talkActive = false;
    // Turno de palabra / contador / calidad: estado por SESION, nunca heredado (2026-07-26,
    // §1.4-ter). Va ANTES de repintar el boton para que _paintMicState() vea ya el estado limpio.
    this._resetMulticlientState();
    if (micWasOpen) this._setAudioOn(this._audioOnBeforeMic, 'teardown');
    if (this.micButton) {
      this.micButton.setAttribute('disabled', '');
      this._paintMicState();
    }
    if (this.audioPill) this.audioPill.style.display = 'none';
    this._updateMotionPill(); // la regla "nunca con el mic activo" ya no aplica tras este reset
    this._disarmDoorConfirm();     // una confirmacion a medias no sobrevive a un corte de sesion
    this._clearDoorWait(); // ni un "Abriendo..." de una sesion que ya no existe
    if (this.unlockButton) {
      this.unlockButton.classList.remove('active-unlock');
      this.unlockButton.setAttribute('disabled', '');
      if (this.unlockIcon) this.unlockIcon.setAttribute('icon', 'mdi:key');
      this._setDoorLabel(false);
    }
    if (this._doorCountdownTimer) { clearInterval(this._doorCountdownTimer); this._doorCountdownTimer = null; }
    this._resetStatusLine();
    if (this.pc) { this.pc.close(); this.pc = null; }
    if (this.nativeSSE) {
      // Corregido (2026-07-10, ver COORDINATION.md): faltaba mandar 'bye' aqui para el camino
      // local antes de cerrar - solo el camino remoto (mas abajo) lo hacia, así que cambiar de
      // vista de Lovelace (o reconectar) con una sesion local activa dejaba el slot ocupado
      // hasta el timeout de abandono del doorbell en vez de liberarse al instante. Un fetch()
      // normal basta aqui (a diferencia de _sendByeOnUnload/pagehide) porque la propia pagina
      // sigue viva.
      try { this.sendNativeSignal({ type: 'bye' }); } catch (err) { /* best effort */ }
      this.nativeSSE.close();
      this.nativeSSE = null;
    }
    if (this.nativeWS) {
      if (this._slot !== null || this.nativeWS.readyState === WebSocket.OPEN) {
        try { this.sendNativeSignal({ type: 'bye' }); } catch (err) { /* best effort */ }
      }
      this.nativeWS.close();
      this.nativeWS = null;
    }
    this._slot = null;
  }

  // ==============================================================================
  // VIGILANTE DE SEÑALES DE VIDA + RECONEXION AUTOMATICA (2026-07-10, ver COORDINATION.md Q19).
  // Diseño simetrico con el firmware, que baja su propio timeout de abandono de 45s a 20s: el
  // lado consumidor (esta card) tambien debe dejar de esperar pasivamente y actuar si la sesion
  // lleva ~20s sin ninguna señal de vida real.
  //
  // Señal primaria: progreso real en getStats() del track de video (packetsReceived subiendo) -
  // no el estado de ICE del navegador, que esta gobernado por sus propios checks de "consent
  // freshness" (RFC 7675) y puede seguir diciendo "connected" aunque el video se haya parado por
  // otro motivo (p.ej. un cuelgue del lado servidor); tampoco es ajustable a los 20s exactos que
  // pide el diseño, varia por navegador. getStats() mide justo lo que importa y da control total
  // del umbral. Señal secundaria, para la fase de negociacion ANTES de que haya video: cualquier
  // mensaje de señalización recibido (oferta/candidato/heartbeat) tambien cuenta como vida - ver
  // _recordLifeSignal() llamado desde tryLocalSignaling()/startRelaySignaling().
  //
  // Atajo AGRESIVO (decision del usuario 2026-07-10, mismo criterio que android_app en su propio
  // watchdog): tanto 'failed' COMO 'disconnected' en pc.onconnectionstatechange disparan
  // reconexion inmediata sin esperar el resto del cronometro de 20s - a sabiendas de que
  // 'disconnected' puede ser transitorio y esto podria interrumpir alguna recuperacion normal de
  // vez en cuando; el usuario quiere validarlo en real contra su propia cobertura 4G/5G mala. El
  // chequeo de getStats() de aqui abajo queda como respaldo para el caso que NO cubre ese atajo:
  // "transporte aparentemente sano pero sin datos reales llegando" (connectionState sigue en
  // 'connected' pero el video se paro).
  // ==============================================================================
  _startLifeWatchdog() {
    this._stopLifeWatchdog();
    this._prevPacketsReceived = null;
    this._recordLifeSignal(); // arranca el cronometro desde ahora, no desde "nunca"
    this._watchdogTimer = setInterval(() => this._checkLifeWatchdog(), 5000);
  }

  _stopLifeWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  _recordLifeSignal() {
    this._lastLifeSignalAt = performance.now();
  }

  async _checkLifeWatchdog() {
    if (!this.pc) return;

    try {
      const stats = await this.pc.getStats();
      // Con calidad 'audio_only' (§1.4-ter #3) el dispositivo NO manda ni un paquete de video a
      // este cliente A PROPOSITO - medir el video ahi haria que este vigilante interpretara un
      // silencio esperado como sesion muerta y reconectara en bucle cada 20s, rompiendo justo la
      // funcion que el usuario acaba de pedir. En ese modo (y solo en ese) la señal de vida es el
      // audio, que sigue fluyendo intacto. En 'low' (~1 fps) el video sigue progresando de sobra
      // entre chequeos de 5s, asi que no necesita ningun trato especial.
      const effectiveMeta = qualityModeMeta(this._qualityEffective || this._quality);
      const watchKind = (effectiveMeta && !effectiveMeta.expectsVideo) ? 'audio' : 'video';
      let packetsReceived = null;
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === watchKind) {
          packetsReceived = (typeof report.packetsReceived === 'number')
            ? report.packetsReceived
            : (typeof report.framesReceived === 'number' ? report.framesReceived : null);
        }
      });
      if (packetsReceived !== null) {
        if (this._prevPacketsReceived === null || packetsReceived > this._prevPacketsReceived) {
          this._recordLifeSignal();
          this._confirmLiveFromMedia();
        }
        this._prevPacketsReceived = packetsReceived;
      }
    } catch (err) {
      // No bloqueante - getStats() no deberia fallar en circunstancias normales; si falla, se
      // sigue confiando en la ultima marca de tiempo que ya hubiera (p.ej. de señalización).
      console.warn('[ig-doorbell-card] getStats() fallo durante la vigilancia de vida', err);
    }

    if (this._lastLifeSignalAt !== null && (performance.now() - this._lastLifeSignalAt) >= 20000) {
      this._scheduleReconnect('20s sin señales de vida reales (getStats sin progreso / sin señalización)');
    }
  }

  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  // Punto unico de reconexion, usado por: el vigilante de 20s, el atajo de connectionState
  // failed/disconnected, y un 'bye' recibido del propio dispositivo (p.ej. desplazado por otra
  // sesion). Reutiliza startWebRTC() (el mismo punto de entrada de la conexion inicial) en vez
  // de duplicar la logica de conexion - vuelve a intentar local-primero-luego-remoto desde cero,
  // razonable porque las condiciones de red pueden haber cambiado.
  _scheduleReconnect(reason) {
    if (this._reconnecting) return;
    this._reconnecting = true;

    console.warn(`[ig-doorbell-card] sesion nativa perdida (${reason}) - reconectando...`);
    this._mark(`_scheduleReconnect: ${reason}`);
    this._teardownConnectionObjects();

    this._setLiveState('connecting');
    if (this.loader) this.loader.style.opacity = '1';

    this._reconnectAttempt += 1;
    // Backoff simple: 2s, 4s, 8s, tope en 15s. Reintentos indefinidos a proposito (decision del
    // usuario, producto de seguridad domestica) - _reconnectAttempt se resetea a 0 en cuanto un
    // reconecto realmente trae video de vuelta, ver setupRemoteStream().
    const backoffMs = Math.min(2000 * Math.pow(2, this._reconnectAttempt - 1), 15000);
    this._mark(`_scheduleReconnect: reintento #${this._reconnectAttempt} en ${backoffMs}ms`);
    // §1.0: el velo de carga vuelve a girar aqui, y hasta ahora giraba SIN DECIR NADA. Un
    // indicador que gira indefinidamente sin explicacion es peor que no tener ninguno: el usuario
    // no sabe si esperar o si la card esta rota. Con la cuenta atras a la vista, girar deja de ser
    // ambiguo - se ve que hay un plan y cuando toca el siguiente intento.
    this._startRetryCountdown(backoffMs);

    this._clearReconnectTimer();
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnecting = false;
      this.startWebRTC();
    }, backoffMs);
  }

  // ==============================================================================
  // ESTADO VISUAL LIGADO A HASS (2026-07-10, ver COORDINATION.md Q22-bis) - chips de modo y
  // chip de movimiento, ambos opcionales (solo aparecen si el usuario configura la entidad
  // correspondiente). `set hass()` llama aqui en cada tick de estado de HA (potencialmente muy
  // frecuente) - cada sub-metodo hace su propia comparacion barata antes de tocar el DOM.
  // ==============================================================================
  _updateHassBoundUI() {
    if (!this.content) return;
    this._updateModeRow();
    this._updateMotionPill();
    this._updateRingState();
    this._repaintTextsIfLanguageChanged();
  }

  // Idioma: repintar los textos que solo se escriben UNA vez (2026-07-29, encontrado midiendo con
  // Playwright, no razonando). Home Assistant llama SIEMPRE a setConfig() antes de asignar `hass`
  // - y es setConfig() quien llama a render(). O sea que todo el HTML inicial de la card se pinta
  // con `this._hass` todavia sin definir, y getLocalText() cae a ingles pase lo que pase, tambien
  // para un usuario con Home Assistant en español. La mayoria de los textos se salvaban de rebote
  // porque algo los repinta al conectar (el badge, las etiquetas de los botones, la linea de
  // estado); los que no dependen del estado - el titulo del boton de pantalla completa, el del
  // contador de clientes, el menu de calidad - se quedaban en ingles para siempre, en silencio.
  // Se compara el idioma efectivamente pintado para no rehacer nada en cada tick de estado de HA,
  // que puede ser muy frecuente.
  _repaintTextsIfLanguageChanged() {
    const lang = (this._hass && this._hass.language) ? this._hass.language.substring(0, 2) : 'en';
    if (this._paintedLang === lang) return;
    this._paintedLang = lang;
    this._paintFullscreenButton();
    if (this.clientsPill) this.clientsPill.setAttribute('title', getLocalText(this._hass, 'clients_tip'));
    if (this.qualityBtn) this.qualityBtn.setAttribute('title', getLocalText(this._hass, 'q_label'));
    if (this.qualityMenu) { this._renderQualityMenu(); this._paintQuality(); }
    // Las dos pildoras sobre el video estan en el HTML inicial y no las repinta nadie nunca: son
    // texto fijo, solo se muestran y se ocultan. Sin esto se quedaban en ingles igual que el resto
    // - y "Audio active" sobre el video es de lo mas visible que tiene la card.
    const audioTxt = this.audioPill && this.audioPill.querySelector('span');
    if (audioTxt) audioTxt.textContent = getLocalText(this._hass, 'audio_active');
    const motionTxt = this.motionPill && this.motionPill.querySelector('span');
    if (motionTxt) motionTxt.textContent = getLocalText(this._hass, 'motion_detected');
    this._paintAudioState(); // el titulo del control de altavoz tambien se escribe una sola vez
    // El badge de estado y la linea inferior se repintan solos en cuanto la sesion cambia de
    // estado, asi que casi siempre se arreglaban solos. Casi: una card que NUNCA llega a
    // conectar - el portero apagado, o fuera de casa sin cobertura - se queda con el
    // "Connecting..." inicial en ingles indefinidamente, que es justo el momento en el que el
    // usuario mas mira ese texto. Se repintan con el estado que ya hay, sin cambiarlo.
    if (this._liveStateKey || this.badge) this._setLiveState(this._liveStateKey || 'connecting');
    // La linea de estado solo si esta en reposo: un aviso en curso ("Puerta abierta · Cerrando
    // en Ns", "canal ocupado") no debe borrarse porque Home Assistant haya mandado un tick.
    if (this.statusLine && !this.statusLine.classList.contains('open') && !this.statusLine.classList.contains('warn')) {
      this._resetStatusLine();
    }
  }

  _modeKeyFor(label) {
    const l = (label || '').toLowerCase();
    if (l.includes('ausente') || l.includes('away') || l.includes('fuera')) return 'away';
    if (l.includes('noche') || l.includes('night')) return 'night';
    if (l.includes('custom') || l.includes('personalizado')) return 'custom';
    if (l.includes('normal') || l.includes('home') || l.includes('casa')) return 'normal';
    return null;
  }

  _updateModeRow() {
    if (!this.modeRow) return;
    const entityId = this.config.mode_entity;
    const stateObj = entityId && this._hass ? this._hass.states[entityId] : null;
    if (!stateObj) {
      this.modeRow.style.display = 'none';
      this._lastModeSig = null;
      return;
    }
    const options = (stateObj.attributes && Array.isArray(stateObj.attributes.options)) ? stateObj.attributes.options : [];
    if (options.length === 0) {
      this.modeRow.style.display = 'none';
      return;
    }
    const sig = `${entityId}|${stateObj.state}|${options.join(',')}`;
    if (this._lastModeSig === sig) return; // sin cambios reales, evita repintar en cada tick de hass
    this._lastModeSig = sig;

    this.modeRow.style.display = 'flex';
    this.modeRow.innerHTML = options.map((opt) => {
      const key = this._modeKeyFor(opt);
      const meta = key ? MODE_META[key] : null;
      const active = opt === stateObj.state;
      const cls = ['chip', active ? 'active' : '', key ? `mode-${key}` : ''].filter(Boolean).join(' ');
      const icon = meta ? meta.icon : 'mdi:circle-outline';
      const safeOpt = String(opt).replace(/"/g, '&quot;');
      return `<button type="button" class="${cls}" data-option="${safeOpt}"><ha-icon icon="${icon}"></ha-icon><span>${opt}</span></button>`;
    }).join('');

    this.modeRow.querySelectorAll('.chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        this._hass.callService('select', 'select_option', { entity_id: entityId, option: btn.getAttribute('data-option') });
      });
    });
  }

  _updateMotionPill() {
    if (!this.motionPill) return;
    const entityId = this.config.motion_entity;
    const stateObj = entityId && this._hass ? this._hass.states[entityId] : null;
    // Regla acordada explicitamente (COORDINATION.md Q22-bis): nunca visible con el mic activo.
    const shouldShow = !!stateObj && stateObj.state === 'on' && !this.talkActive;
    this.motionPill.style.display = shouldShow ? 'flex' : 'none';
  }

  // ==============================================================================
  // Estado visual del "live-tag" (pildora EN VIVO/Conectando/Error superpuesta al video, esquina
  // superior izquierda) y de las etiquetas bajo los botones de accion - centralizado para que
  // cada sitio que antes hacia `this.badge.textContent = ...` a mano tenga un unico punto que
  // ademas actualiza el color/pulso del punto y no se desincronice.
  // ==============================================================================
  // El chip de estado lo gobierna la REALIDAD, no solo la señalización (2026-07-29, reportado en
  // hardware real: "vi error en el chip de estado a la vez que si habia stream").
  //
  // Como pasaba: el atajo agresivo de reconexion salta tambien con connectionState
  // 'disconnected', que puede ser transitorio. Eso pinta el chip en error; si acto seguido ICE se
  // recupera sola, NADA volvia a poner el chip en su sitio -- setupRemoteStream() solo repinta
  // cuando llega un stream NUEVO, y ahi el stream era el mismo de siempre. El chip se quedaba en
  // error indefinidamente con el video corriendo delante.
  //
  // Por que importa mas de lo que parece: un indicador que miente en la direccion pesimista
  // entrena al usuario a ignorarlo, y entonces ya no sirve el dia que el error es de verdad.
  // Si llegan fotogramas, no hay error: se dice lo que se ve.
  _confirmLiveFromMedia() {
    if (this._liveStateKey !== 'error_cam' && this._liveStateKey !== 'connecting') return;
    this._setLiveState(this.talkActive ? 'open' : 'live');
  }

  _setLiveState(stateKey) {
    if (this.badge) this.badge.textContent = getLocalText(this._hass, stateKey);
    this._liveStateKey = stateKey;
    const dataState = stateKey === 'live' ? 'live'
      : stateKey === 'error_cam' ? 'error'
      : stateKey === 'open' ? 'open'
      : stateKey === 'no_lock' ? 'warn'
      : 'connecting';
    if (this.liveTag) this.liveTag.dataset.state = dataState;
    // Tambien en .feed-wrap (no solo en .live-tag) para que las barras de señal del HUD
    // (esquina inferior-dcha, ver COORDINATION.md Q22-bis) reaccionen por CSS puro al mismo
    // estado, sin duplicar logica JS - mismo principio que ya usa .live-tag[data-state=...].
    if (this.feedWrap) this.feedWrap.dataset.state = dataState;
  }

  _updateHudClock() {
    if (!this.hudTimeHm) return;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    this.hudTimeHm.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    this.hudTimeDate.textContent = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${String(now.getFullYear()).slice(-2)}`;
  }

  // NOTA (2026-07-26): el antiguo _setMicLabel(active) desaparecio al introducirse el turno de
  // palabra - el boton de micro ya no tiene dos estados (on/off) sino cinco (apagado, pidiendo
  // turno, hablando, solo escucha, ocupado por otro), y tenerlos repartidos entre varias
  // funciones era la receta para que se desincronizaran. Todo eso vive ahora en un unico
  // _paintMicState(), mas abajo.

  _setDoorLabel(active) {
    if (!this.unlockLabel) return;
    this.unlockLabel.textContent = getLocalText(this._hass, active ? 'lbl_door_open' : 'lbl_door_idle');
    this.unlockLabel.classList.toggle('on-green', !!active);
  }

  // Linea de estado bajo el video (distinta del live-tag: esa es sobre el ESTADO DE CONEXION,
  // esta es sobre el ESTADO DE LA PUERTA). Cuenta atras real, actualizada cada segundo.
  _startDoorCountdown(seconds) {
    if (!this.statusLine) return;
    if (this._doorCountdownTimer) { clearInterval(this._doorCountdownTimer); this._doorCountdownTimer = null; }
    let remaining = Math.max(1, parseInt(seconds, 10) || 1);
    const paint = () => {
      this.statusLine.textContent = `${getLocalText(this._hass, 'door_open_prefix')} ${remaining}s`;
      this.statusLine.classList.remove('warn');
      this.statusLine.classList.add('open');
    };
    paint();
    this._doorCountdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(this._doorCountdownTimer);
        this._doorCountdownTimer = null;
        this._resetStatusLine();
        return;
      }
      paint();
    }, 1000);
  }

  // Cuenta atras del proximo reintento de conexion (§1.0). Misma forma que la de la puerta, y por
  // el mismo motivo: un numero que baja se lee de un vistazo como "esto sigue vivo", mientras que
  // un texto fijo -o peor, solo un circulito girando- no distingue "esperando" de "colgado".
  //
  // Cede ante el aviso pegajoso de emparejamiento rechazado: ahi el problema no es la espera sino
  // que hay algo que hacer, y tapar esa frase con un contador seria cambiar informacion util por
  // ruido.
  _startRetryCountdown(ms) {
    if (!this.statusLine || this._stickyStatusKey) return;
    if (this._doorCountdownTimer) { clearInterval(this._doorCountdownTimer); this._doorCountdownTimer = null; }
    if (this._retryCountdownTimer) { clearInterval(this._retryCountdownTimer); this._retryCountdownTimer = null; }
    let secondsLeft = Math.max(1, Math.round(ms / 1000));
    const paintCountdown = () => {
      this.statusLine.textContent = `${getLocalText(this._hass, 'retry_prefix')} ${secondsLeft}s`;
      this.statusLine.classList.remove('open');
      this.statusLine.classList.add('warn');
    };
    paintCountdown();
    this._retryCountdownTimer = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft <= 0) {
        clearInterval(this._retryCountdownTimer);
        this._retryCountdownTimer = null;
        // No se vuelve a "Sistema operativo": se esta reconectando de verdad en este instante.
        this.statusLine.textContent = getLocalText(this._hass, 'connecting');
        return;
      }
      paintCountdown();
    }, 1000);
  }

  _stopRetryCountdown() {
    if (this._retryCountdownTimer) { clearInterval(this._retryCountdownTimer); this._retryCountdownTimer = null; }
  }

  _flashStatusLine(stateKey, ms) {
    if (!this.statusLine) return;
    this._stopRetryCountdown();
    if (this._doorCountdownTimer) { clearInterval(this._doorCountdownTimer); this._doorCountdownTimer = null; }
    this.statusLine.textContent = getLocalText(this._hass, stateKey);
    this.statusLine.classList.remove('open');
    this.statusLine.classList.add('warn');
    setTimeout(() => { if (!this._doorCountdownTimer && !this._retryCountdownTimer) this._resetStatusLine(); }, ms);
  }

  _resetStatusLine() {
    if (!this.statusLine) return;
    // Un aviso PEGAJOSO (hoy solo el de emparejamiento rechazado) describe una situacion que sigue
    // ahi: no puede borrarlo un temporizador ni un tick de Home Assistant. Solo lo quita el propio
    // motivo al desaparecer - ver _clearPairingRejected().
    if (this._stickyStatusKey) {
      this.statusLine.textContent = getLocalText(this._hass, this._stickyStatusKey);
      this.statusLine.classList.remove('open');
      this.statusLine.classList.add('warn');
      return;
    }
    this.statusLine.classList.remove('open', 'warn');
    this.statusLine.textContent = getLocalText(this._hass, 'idle_status');
  }

  // ==============================================================================
  // "EL PORTERO NO ME CONOCE": credencial de emparejamiento rechazada
  //
  // Pasa de verdad y no es raro: un factory reset del portero borra la NVS, y con ella los hashes
  // de las credenciales de pair_app que valida el camino local (§1.5). La card se autentica con
  // esa credencial y con ninguna otra - deliberadamente no guarda usuario/contraseña de
  // administrador, que es justo lo que el emparejamiento existe para evitar (§4).
  //
  // Lo que NO debe pasar, y es lo que pasaba: quedarse reintentando en silencio con el chip en
  // "Conectando..." indefinidamente. Reintentar esta bien (el portero puede volver), pero el
  // usuario tiene que poder leer que lo que falta es volver a emparejar, no esperar.
  //
  // Las tres señales fiables, todas con codigo, ninguna adivinada:
  //   - relay: cierre del WebSocket con codigo 4401 (§3.2)
  //   - nube: get_turn_credentials responde 'unauthorized' (§3.1-bis)
  //   - local: el proxy de senalizacion de Home Assistant devuelve 401 (lo pasa tal cual desde el
  //     portero, precisamente para que un cliente pueda decir "vuelve a emparejar")
  // ==============================================================================
  _reportPairingRejected(source) {
    if (this._pairingRejected) return; // ya avisado, no repintar en cada reintento
    this._pairingRejected = true;
    this._stickyStatusKey = 'cred_revoked';
    console.error(`[ig-doorbell-card] el emparejamiento de esta card ha sido rechazado (${source}) - hay que volver a emparejar el portero en Ajustes > Dispositivos y servicios > IG Doorbell`);
    this._resetStatusLine();
  }

  _clearPairingRejected() {
    if (!this._pairingRejected) return;
    this._pairingRejected = false;
    this._stickyStatusKey = null;
    this._resetStatusLine();
  }

  // ==============================================================================
  // MULTICLIENTE: TURNO DE PALABRA (API_CONTRACT.md §1.4-ter #1)
  //
  // El portero tiene UN solo canal de voz: hasta el contrato de 2026-07-26, dos clientes con el
  // micro abierto metian sus dos flujos CONCATENADOS en el mismo buffer del altavoz
  // (ininteligible, y al doble del ritmo al que el altavoz drena). Ahora el arbitraje es por
  // slot: esta card pide el turno ANTES de desmutear y solo abre el micro con un talk_granted
  // real - nunca "abre el micro y a ver si suena".
  //
  // Degradacion con firmware ANTERIOR al contrato (requisito explicito): ese firmware
  // simplemente NO CONTESTA a talk_request - no hay error, hay silencio. Un cliente que esperara
  // indefinidamente dejaria el boton de micro inservible para siempre contra el parque ya
  // instalado. Por eso: 3s de espera (mismo plazo que la app Android, para que el producto se
  // comporte igual en los tres clientes) y, si no llega nada, se abre el micro igualmente
  // avisando UNA vez, y se marca _talkUnsupported para que las siguientes pulsaciones de ESA
  // sesion sean instantaneas. El propio firmware nuevo respalda esta eleccion: implementa "toma
  // implicita del turno" precisamente para que los clientes que nunca piden turno sigan
  // funcionando (§1.4-ter, "Compatibilidad").
  // ==============================================================================
  _requestTalkTurn() {
    if (this._talkUnsupported) {
      // Ya sabemos (en ESTA sesion) que este portero no arbitra el turno - micro directo, sin
      // hacer esperar al usuario 3s otra vez.
      this._startTalk();
      return;
    }
    this._talkPending = true;
    this._paintMicState();
    this.sendNativeSignal({ type: 'talk_request' });
    if (this._talkTimer) clearTimeout(this._talkTimer);
    this._talkTimer = setTimeout(() => {
      this._talkTimer = null;
      if (!this._talkPending) return;
      this._talkPending = false;
      // NO acusar por ausencia si hay pruebas de lo contrario (2026-07-29, tras el falso positivo
      // en hardware real). `session_info` es del MISMO contrato que el turno de palabra: un
      // portero que lo manda sabe arbitrar turnos, y punto. Si lo hemos recibido alguna vez,
      // quedarse sin respuesta a un talk_request es un mensaje perdido -- los avisos de estado se
      // descartan cuando la cola de salida esta llena, esta documentado -- no un firmware viejo.
      //
      // La diferencia importa: acusar al firmware del usuario cuando su firmware esta bien le
      // manda a buscar una actualizacion que no existe, y ademas deja `_talkUnsupported` puesto
      // para el resto de la sesion, con lo que ya nunca se vuelve a pedir el turno como es debido.
      // Sin pruebas (nunca llego un session_info) la suposicion de firmware anterior si es
      // razonable, y se mantiene.
      if (this._clients === null) {
        this._talkUnsupported = true;
        console.warn('[ig-doorbell-card] el dispositivo no contesto a talk_request en 3s y nunca ha mandado session_info - se asume firmware anterior al contrato de turno de palabra y se abre el micro sin arbitraje');
        this._flashStatusLine('talk_legacy', 5000);
      } else {
        console.warn('[ig-doorbell-card] sin respuesta a talk_request en 3s, pero este portero SI habla el contrato de turno de palabra (ha mandado session_info) - se trata como mensaje perdido, no como firmware anterior: se abre el micro y se seguira pidiendo el turno con normalidad');
      }
      this._startTalk();
    }, 3000);
  }

  // ¿Es este talk_granted/talk_denied REALMENTE para nosotros?
  //
  // RESOLUCION DE CONTRATO COMUN A LOS TRES CLIENTES (card, Android, iOS - 2026-07-26, decidida
  // por el lider tras revisar el codigo de los tres). Tres reglas, y las tres importan:
  //
  //   1. NUNCA aprender la identidad propia de un mensaje que se esta validando. Es circular: si
  //      `talk_granted` pudiera fijar `this._slot`, entonces `msg.slot === this._slot` seria
  //      verdadero SIEMPRE y la comprobacion no comprobaria nada. La app Android tenia
  //      exactamente ese fallo (`_mySlot ??= msg.slot` dentro del propio handler). Por eso el
  //      slot propio se aprende SOLO en `offer`/`session_info` - ver handleNativeSignal(), y NO
  //      lo muevas de ahi por comodidad.
  //   2. Se exigen LAS DOS guardias, no una: peticion propia en vuelo (`_talkPending`) Y slot
  //      coincidente. Cada una tapa un agujero distinto (ver el caso de abajo).
  //   3. Slot propio desconocido => RECHAZAR. Esta funcion devolvia `true` en ese caso hasta esta
  //      resolucion; era el eslabon debil.
  //
  // Por que rechazar es correcto y no rompe nada, con el firmware real delante: `sig_out_push()`
  // añade `slot` a TODOS los mensajes del dispositivo por AMBOS transportes, incluida la propia
  // oferta. Cuando el usuario puede pulsar el boton de micro (habilitado solo al llegar el video,
  // mucho despues de la oferta) el slot propio ya se conoce SIEMPRE => cero falsos negativos.
  //
  // Y el caso peligroso de verdad, que SOLO cubre esta regla: dos usuarios pulsando el micro a la
  // vez, los dos con peticion en vuelo, y el `talk_granted` de uno llegandole al otro por el
  // fan-out del relay. Ahi `_talkPending` es true en AMBOS, asi que la guardia de la peticion
  // propia no para nada - solo lo para comparar el slot. Aceptar "porque no se quien soy" seria
  // abrirle el microfono al usuario equivocado justo en el momento de mayor concurrencia.
  //
  // Asimetria deliberada con el mensaje SIN `slot` (firmware intermedio, entre el contrato viejo
  // y este): ese si se acepta apoyandose solo en `_talkPending`. No es el mismo caso: ahi el dato
  // no existe, y rechazar dejaria el micro inservible contra ese firmware - justo la degradacion
  // que este proyecto no acepta. En el caso de arriba el dato SI existe y somos nosotros los que
  // no sabemos con que compararlo, que es sintoma de un estado corrupto, no de un portero viejo.
  // Consecuencia honesta del rechazo, documentada para que nadie la descubra por sorpresa: si se
  // rechaza un talk_granted, la peticion sigue "en vuelo" y a los 3s salta el temporizador de
  // firmware-antiguo, que abre el micro sin arbitraje. En la practica es inalcanzable (el slot
  // propio se conoce siempre antes de que el boton de micro se habilite, ver arriba) y aun asi
  // no es peor que el comportamiento anterior al contrato; añadir mas maquinaria para un camino
  // que no puede darse costaria mas de lo que arregla.
  _talkMsgIsForUs(msg) {
    if (typeof msg.slot !== 'number') return true; // firmware intermedio: no hay slot que comparar
    if (this._slot === null) return false;         // no sabemos quienes somos: no es asumible
    return msg.slot === this._slot;
  }

  _handleTalkGranted(msg) {
    // Excepcion deliberada al filtro por slot. Corrige un fallo REAL visto en un iPhone contra
    // hardware de verdad (2026-07-29): al abrir el micro salia "este portero no confirma el turno
    // de voz (firmware anterior)" con un portero perfectamente al dia.
    //
    // Causa: por el camino REMOTO la oferta no lleva `slot` -- no le hace falta, el relay enruta
    // por device_id -- asi que el slot propio no se conoce hasta el primer `session_info`. Si el
    // usuario pulsaba el micro en esa ventana, _talkMsgIsForUs() descartaba nuestro PROPIO
    // talk_granted por no poder compararlo, se agotaban los 3s y se acusaba al firmware.
    //
    // Un talk_granted solo se manda A QUIEN LO PIDIO, y aqui consta que lo pedimos nosotros
    // (_talkPending). El riesgo residual -- que el relay difunda el granted de otro cliente que
    // pidiera el turno en ese mismo instante -- se acepta a conciencia, porque lo que el filtro
    // evitaba aqui NO era abrir el micro: al agotarse los 3s se abria igual, solo que mas tarde y
    // culpando al firmware del usuario. No protegia nada, y mentia.
    //
    // El slot NO se adopta de este mensaje: lo fija `session_info`, que si es inequivocamente
    // nuestro. Hasta entonces _reconcileTalkTurn() ya se abstiene de opinar.
    const oursByRequest = this._talkPending && this._slot === null;
    if (msg && !this._talkMsgIsForUs(msg) && !oursByRequest) return;
    // NUNCA abrir el micro sin que el usuario lo haya pedido. Un talk_granted que no responde a
    // un talk_request nuestro puede ser (a) la reconfirmacion de un turno que ya teniamos
    // (§1.4-ter: repetir talk_request es la forma natural de decir "sigo aqui"), o (b) - camino
    // REMOTO - un mensaje destinado a OTRA sesion: el relay es un reenviador con fan-out a TODOS
    // los clientes conectados a ese device_id (§3.2, verificado en relay.py), asi que un cliente
    // remoto puede recibir mensajes que no son suyos. Abrir el microfono de alguien por un
    // mensaje ajeno seria un fallo de privacidad, no solo un bug de UI.
    if (!this._talkPending) {
      if (this.talkActive) { this._talkHeld = true; this._talkGrantedAt = performance.now(); }
      return;
    }
    if (this._talkTimer) { clearTimeout(this._talkTimer); this._talkTimer = null; }
    this._talkHeld = true;
    this._talkGrantedAt = performance.now();
    this._talkPending = false;
    this._startTalk();
  }

  _handleTalkDenied(msg) {
    // Mismo razonamiento que en _handleTalkGranted: sin peticion propia en vuelo, esto no es
    // nuestro (fan-out del relay) - ignorarlo en vez de cerrarle el micro al usuario.
    if (msg && !this._talkMsgIsForUs(msg)) return;
    if (!this._talkPending) return;
    if (this._talkTimer) { clearTimeout(this._talkTimer); this._talkTimer = null; }
    this._talkPending = false;
    this._talkHeld = false;
    console.warn(`[ig-doorbell-card] turno de palabra denegado por el dispositivo (reason=${(msg && msg.reason) || 'sin motivo'})`);
    // Estado intermedio HONESTO, no un fallo silencioso: se desmutea el altavoz (se OYE al
    // portero) pero el micro sigue cerrado, y se dice por que. Sin este estado, "ocupado" seria
    // un boton que no hace nada.
    this._enterListenOnly();
    this._flashStatusLine('talk_denied_msg', 5000);
  }

  // talk_state llega a TODOS los clientes en cada cambio. Es tambien como el dispositivo avisa
  // de que nos ha QUITADO el turno por su cuenta - que te corten el micro a media frase sin decir
  // nada seria justo el fallo silencioso a evitar. Plazos reales tras el ajuste de contrato del
  // 2026-07-26: 60s de silencio ABSOLUTO si el turno se pidio con talk_request (lo que hace esta
  // card), y solo 5s para quien lo tomo implicitamente hablando sin pedirlo - o sea, esta misma
  // card cuando habla contra un portero con firmware anterior (_talkUnsupported). Esa asimetria
  // es justo el motivo por el que merece la pena pedir el turno explicitamente.
  _reconcileTalkTurn() {
    // Reintento tras un talk_denied: el dispositivo empuja SIEMPRE talk_state{talker:-1} al
    // quedar libre el canal (ajuste de contrato 2026-07-26), asi que se puede avisar al usuario
    // en el momento exacto en que ya puede hablar, en vez de dejarle probando a ciegas. NO se
    // reabre el micro solo: el usuario pidio hablar hace rato y podria no estar ya delante -
    // abrirle el microfono sin que vuelva a pulsar seria una sorpresa desagradable, no una
    // comodidad.
    if (this._listenOnly && this._talkerSlot < 0 && !this._talkFreeHintShown) {
      this._talkFreeHintShown = true;
      this._flashStatusLine('talk_free_retry', 5000);
    }
    if (this._talkerSlot >= 0) this._talkFreeHintShown = false; // rearma el aviso para la proxima

    if (!this.talkActive) { this._paintMicState(); return; }
    if (this._slot === null) { this._paintMicState(); return; } // sin slot propio no se puede afirmar nada
    if (this._talkerSlot === this._slot) { this._paintMicState(); return; }
    // Gracia anti-carrera: un talk_state "viejo" (emitido justo antes de nuestro talk_granted)
    // no debe cerrarnos el micro que acabamos de abrir.
    if (performance.now() - this._talkGrantedAt < 1500) return;

    const takenByOther = this._talkerSlot >= 0;
    this._talkHeld = false;
    this._enterListenOnly();
    this._flashStatusLine(takenByOther ? 'talk_taken' : 'talk_silence', 5000);
  }

  // Se oye al portero, pero sin micro. Reutiliza el mismo camino de cierre de micro que
  // _stopIntercom() para no duplicar la logica de replaceTrack/stop de pistas.
  _enterListenOnly() {
    this._closeMicHardware();
    this.talkActive = false;
    this._listenOnly = true;
    // Turno denegado: el micro se cierra pero SE SIGUE OYENDO. Es exactamente la independencia
    // entre escuchar y hablar que pide §1.10, y el usuario ya hizo el gesto (pulso el micro).
    this._setAudioOn(true, 'solo-escucha');
    this._setLiveState('live');
    if (this.audioPill) this.audioPill.style.display = 'none';
    this._paintMicState();
    this._updateMotionPill();
  }

  // Pinta el boton de micro segun el estado real del turno. Un unico sitio que decide
  // icono/clase/etiqueta, para que no puedan desincronizarse entre los 6 caminos que lo tocan.
  _paintMicState() {
    if (!this.micButton) return;
    const btn = this.micButton;
    btn.classList.toggle('active-talk', !!this.talkActive);
    btn.classList.toggle('requesting', !!this._talkPending);
    btn.classList.toggle('listen-only', !!this._listenOnly);
    // "Ocupado por otro" = alguien tiene el turno y no somos nosotros. NO deshabilita el boton a
    // proposito (se puede pulsar y recibir un talk_denied explicito con su aviso) - un boton
    // deshabilitado por un estado remoto es exactamente el "bloqueado para siempre" a evitar si
    // el aviso de liberacion se perdiera.
    const busyByOther = this._talkerSlot >= 0 && this._slot !== null && this._talkerSlot !== this._slot;
    btn.classList.toggle('busy-other', !!busyByOther && !this.talkActive);
    btn.title = busyByOther && !this.talkActive ? getLocalText(this._hass, 'talk_busy') : '';

    if (this.micIcon) {
      this.micIcon.setAttribute('icon',
        this._talkPending ? 'mdi:microphone-question'
          : this.talkActive ? 'mdi:microphone'
            : this._listenOnly ? 'mdi:ear-hearing'
              : 'mdi:microphone-off');
    }
    if (this.micLabel) {
      const key = this._talkPending ? 'talk_requesting'
        : this.talkActive ? 'lbl_mic_on'
          : this._listenOnly ? 'lbl_mic_listen'
            : 'lbl_mic_off';
      this.micLabel.textContent = getLocalText(this._hass, key);
      this.micLabel.classList.toggle('on-cyan', !!this.talkActive);
      this.micLabel.classList.toggle('on-amber', !!this._listenOnly || !!this._talkPending);
    }
  }

  // ==============================================================================
  // MULTICLIENTE: CONTADOR DE CLIENTES (API_CONTRACT.md §1.4-ter #2, mensaje session_info)
  // Cuenta SOLO sesiones WebRTC - los clientes RTSP/NVR no salen aqui a proposito (son
  // grabadores de terceros, no personas mirando).
  // ==============================================================================
  _handleSessionInfo(msg) {
    if (typeof msg.clients === 'number') this._clients = msg.clients;
    if (typeof msg.talker === 'number') this._talkerSlot = msg.talker;
    // Tipo de cerradura, desde 2026-07-29. Llega en cada session_info (~4s), asi que un cambio
    // hecho en el dashboard del portero con esta card abierta se refleja sin reconectar. Solo se
    // repinta cuando cambia de verdad: esto se ejecuta varias veces por minuto.
    if (typeof msg.door_m === 'number' && msg.door_m !== this._doorMode) {
      this._doorMode = msg.door_m;
      this._applyDoorAvailability();
    }
    // Giro de la imagen (§1.9, 2026-07-30). Viaja aqui por el mismo motivo que `door_m`: es lo que
    // permite a un cliente que abre video enderezar la imagen sin pedir nada mas - `get_states`
    // tambien lo lleva, pero exige cookie de administrador, que una card emparejada no tiene.
    // _applyRotation() sale por su cuenta si no ha cambiado: esto corre varias veces por minuto.
    if (typeof msg.rot === 'number') this._applyRotation(msg.rot);
    this._paintClients();
    this._reconcileTalkTurn();
  }

  _paintClients() {
    if (!this.clientsPill) return;
    if (this._clients === null) { this.clientsPill.style.display = 'none'; return; }
    this.clientsPill.style.display = 'flex';
    this.clientsCount.textContent = String(this._clients);
    // Resaltado solo cuando hay MAS de uno: "hay alguien mas mirando" es el dato que cambia como
    // te comportas; "estas tu solo" es el caso normal y no debe llamar la atencion.
    this.clientsPill.classList.toggle('multi', this._clients > 1);
  }

  // ==============================================================================
  // MULTICLIENTE: CALIDAD POR DESTINATARIO (API_CONTRACT.md §1.4-ter #3)
  //
  // Sonda de capacidad: nada mas negociar la sesion se manda {"type":"quality","mode":"auto"}.
  // Sirve para dos cosas a la vez: (1) dejar la sesion en 'auto' desde el principio (el
  // dispositivo arranca cada slot en 'full', y 'auto' es lo que queremos por defecto para que el
  // dia que el firmware consuma RTCP RR pueda degradar solo sin que el usuario toque nada), y
  // (2) descubrir SIN que el usuario tenga que pulsar nada si este firmware entiende el mensaje.
  // Solo si llega el quality_state de vuelta se muestra el selector. Un reintento antes de darse
  // por vencido porque el contrato advierte que los avisos de estado pueden descartarse si la
  // cola de salida de esa sesion esta llena.
  // ==============================================================================
  _probeQualitySupport() {
    this._qualityProbeAttempts = 0;
    this._quality = 'auto';
    this._sendQuality('auto');
  }

  _sendQuality(mode) {
    this._quality = mode;
    this.sendNativeSignal({ type: 'quality', mode });
    if (this._qualityProbeTimer) { clearTimeout(this._qualityProbeTimer); this._qualityProbeTimer = null; }
    if (this._qualitySupported === true) {
      this._paintQuality();
      return;
    }
    this._qualityProbeTimer = setTimeout(() => {
      this._qualityProbeTimer = null;
      if (this._qualitySupported === true) return;
      this._qualityProbeAttempts += 1;
      if (this._qualityProbeAttempts < 2) {
        this._sendQuality(mode);
        return;
      }
      this._qualitySupported = false;
      this._paintQuality();
      // Sin aviso en la UI a proposito: el unico camino que llega aqui es la sonda automatica del
      // arranque (una vez _qualitySupported es true el selector aparece y este temporizador ya no
      // se arma; mientras no lo es, el selector esta oculto y el usuario no puede pedir nada). Un
      // portero con firmware anterior funciona perfectamente sin esta funcion - molestar al
      // usuario con un aviso por algo que el no ha pedido seria ruido, no informacion.
      console.warn('[ig-doorbell-card] el dispositivo no confirmo ningun quality_state tras 2 intentos - firmware anterior al contrato de calidad (2026-07-26): el selector de calidad no se muestra en esta sesion');
    }, 4000);
  }

  _handleQualityState(msg) {
    if (this._qualityProbeTimer) { clearTimeout(this._qualityProbeTimer); this._qualityProbeTimer = null; }
    this._qualitySupported = true;
    if (typeof msg.mode === 'string' && msg.mode !== this._qualityEffective) {
      this._qualityEffective = msg.mode;
      // El vigilante de vida cambia de contador (video <-> audio) segun el modo efectivo, ver
      // _checkLifeWatchdog(): la linea base anterior es de OTRO contador, asi que compararlas
      // daria un falso "no progresa". Se reinicia la medida y se cuenta el propio cambio como
      // señal de vida (acaba de llegar un mensaje del dispositivo, por definicion esta vivo).
      this._prevPacketsReceived = null;
      this._recordLifeSignal();
    }
    // Si el dispositivo ha decidido por su cuenta (auto_loss/auto_bandwidth), el modo pedido por
    // el usuario NO cambia (sigue en 'auto'): lo que cambia es el modo EFECTIVO. Un cambio de
    // calidad inexplicado se percibe como un fallo, asi que se dice el motivo.
    const reason = msg.reason;
    if (reason === 'auto_loss' || reason === 'auto_bandwidth') {
      this._flashStatusLine(reason === 'auto_loss' ? 'q_auto_loss' : 'q_auto_bw', 6000);
    }
    this._paintQuality();
  }

  _renderQualityMenu() {
    if (!this.qualityMenu) return;
    this.qualityMenu.innerHTML = QUALITY_MODES.map((m) => (
      `<button type="button" class="q-opt" data-mode="${m.wire}"><ha-icon icon="${m.icon}"></ha-icon>` +
      `<span class="q-txt"><b>${getLocalText(this._hass, m.key)}</b><i>${getLocalText(this._hass, m.sub)}</i></span></button>`
    )).join('');
    this.qualityMenu.querySelectorAll('.q-opt').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._toggleQualityMenu(false);
        const mode = btn.getAttribute('data-mode');
        this._sendQuality(mode);
        // Aviso explicito al activar "Baja": ~1 imagen/s se percibe como una averia si nadie ha
        // dicho que es lo esperado (mismo criterio que la app Android). Solo al ACTIVARLO, no en
        // cada repintado.
        if (mode === 'low') this._flashStatusLine('q_low_warn', 6000);
      });
    });
  }

  _toggleQualityMenu(force) {
    const open = (typeof force === 'boolean') ? force : !this._qualityMenuOpen;
    this._qualityMenuOpen = open;
    if (this.qualityMenu) this.qualityMenu.style.display = open ? 'flex' : 'none';
  }

  _paintQuality() {
    if (!this.qualityCtl) return;
    this.qualityCtl.style.display = this._qualitySupported === true ? 'block' : 'none';
    if (this._qualitySupported !== true) { this._toggleQualityMenu(false); return; }
    // Se muestra el modo PEDIDO, y si el efectivo confirmado por el dispositivo es distinto (hoy
    // solo puede pasar con 'auto', que se comporta como 'full', o cuando el automatico degrade
    // solo en el futuro) se añade entre parentesis: la card nunca debe afirmar que estas viendo
    // algo distinto de lo que el dispositivo dice estar mandando.
    const req = qualityModeMeta(this._quality) || QUALITY_MODES[0];
    const eff = qualityModeMeta(this._qualityEffective);
    const showEff = eff && this._quality === 'auto' && this._qualityEffective !== 'auto';
    if (this.qualityIcon) this.qualityIcon.setAttribute('icon', req.icon);
    if (this.qualityLabel) {
      this.qualityLabel.textContent = showEff
        ? `${getLocalText(this._hass, req.key)} · ${getLocalText(this._hass, eff.key)}`
        : getLocalText(this._hass, req.key);
    }
    this.qualityMenu.querySelectorAll('.q-opt').forEach((btn) => {
      btn.classList.toggle('sel', btn.getAttribute('data-mode') === this._quality);
    });
  }

  // Estado por SESION: el turno de palabra y la calidad viven en el dispositivo por slot, y una
  // sesion nueva arranca siempre sin turno y en 'full'. Heredar cualquiera de las dos cosas de la
  // sesion anterior seria mentir sobre el estado real del otro extremo.
  //
  // `_doorMode` NO se resetea aqui, y es deliberado: no es estado de sesion sino CONFIGURACION del
  // portero, que no cambia porque se caiga la conexion. Olvidarlo en cada reconexion haria
  // reaparecer el boton de abrir unos segundos en un portero sin cerradura, cada vez - justo el
  // parpadeo que este mecanismo existe para evitar. Si de verdad ha cambiado, el primer
  // session_info de la sesion nueva lo corrige.
  _resetMulticlientState() {
    if (this._talkTimer) { clearTimeout(this._talkTimer); this._talkTimer = null; }
    if (this._qualityProbeTimer) { clearTimeout(this._qualityProbeTimer); this._qualityProbeTimer = null; }
    this._talkHeld = false;
    this._talkPending = false;
    this._talkGrantedAt = 0;
    // _talkUnsupported / _qualitySupported se resetean tambien a proposito: si el usuario
    // actualiza el firmware, el dispositivo se reinicia y la card reconecta - re-sondear en cada
    // sesion nueva es lo que hace que la card se entere sola, sin recargar el navegador. El coste
    // es como mucho una espera de 3s la primera vez que se pulsa el micro contra un portero viejo.
    this._talkUnsupported = false;
    this._listenOnly = false;
    this._talkFreeHintShown = false;
    this._talkerSlot = -1;
    this._clients = null;
    this._quality = 'auto';
    this._qualityEffective = null;
    this._qualitySupported = null;
    this._qualityProbeAttempts = 0;
    this._paintClients();
    this._paintQuality();
  }

  // ==============================================================================
  // PANTALLA COMPLETA (2026-07-29). Ver el bloque de
  // comentarios de nativeFullscreenAvailable() arriba para POR QUE hay dos niveles y de donde
  // sale cada caso real.
  //
  // Reglas del contrato que se implementan aqui y NO deben "mejorarse" luego sin releerlo:
  //  - Los controles NO se ocultan solos. Esto no es un reproductor de video: hay alguien
  //    esperando en la puerta, y que el boton de abrir desaparezca a los 3 segundos es
  //    exactamente el momento en que nadie quiere buscar nada. (Aqui no hay nada que programar:
  //    simplemente no existe ningun temporizador de ocultado. Se deja escrito para que a nadie
  //    le parezca un olvido.)
  //  - La pantalla no se apaga mientras el modo esta activo (wake lock).
  //  - El contador de gente mirando sigue visible.
  //  - El boton de abrir solo aparece si hay cerradura configurada.
  // ==============================================================================
  // Los listeners son de DOCUMENTO, no del elemento, asi que hay que quitarlos al salir del DOM
  // (lo hace disconnectedCallback) y volver a ponerlos al reentrar - Home Assistant remonta las
  // cards al cambiar de vista o al editar el dashboard, y render() no se vuelve a ejecutar en ese
  // caso (esta guardado por `if (!this.content)`). De ahi que esto lo llame tambien
  // connectedCallback y no solo render(): si no, la salida con ESC dejaria de funcionar tras el
  // primer remontaje, en silencio.
  _registerFullscreenListeners() {
    if (this._onFsChange) return; // ya registrados
    this._onFsChange = () => this._syncFullscreenFromBrowser();
    document.addEventListener('fullscreenchange', this._onFsChange);
    document.addEventListener('webkitfullscreenchange', this._onFsChange);
    this._onFsKeyDown = (ev) => {
      // En pantalla completa NATIVA el ESC lo gestiona el navegador (y nos avisa por
      // 'fullscreenchange'); aqui solo hace falta para el respaldo propio, que no tiene salida
      // del navegador. Mismo gesto en los dos, que es lo que el contrato pide.
      if (ev.key === 'Escape' && this._fsActive && !this._fsNative) this._exitFullscreen();
    };
    document.addEventListener('keydown', this._onFsKeyDown);
  }

  _toggleFullscreen() {
    if (this._fsActive) this._exitFullscreen();
    else this._enterFullscreen();
  }

  async _enterFullscreen() {
    if (this._fsActive) return;

    // Nivel 1: la API real. Se pide sobre el PROPIO elemento de la card (no sobre el <video>): en
    // pantalla completa nativa el elemento pasa a la "capa superior" del navegador, asi que se
    // salta cualquier `overflow:hidden` o contenedor de Home Assistant sin depender de nada del
    // dashboard - y conserva nuestros botones encima, que es lo que el reproductor nativo de iOS
    // NO haria. El ESC lo gestiona el navegador y nos avisa por 'fullscreenchange'.
    if (nativeFullscreenAvailable()) {
      const req = this.requestFullscreen || this.webkitRequestFullscreen;
      try {
        // `navigationUI:'hide'` es una sugerencia; los navegadores que no la entienden la ignoran.
        await req.call(this, { navigationUI: 'hide' });
        this._fsNative = true;
        this._fsActive = true;
        this._applyFullscreenUI();
        this._acquireWakeLock();
        return;
      } catch (err) {
        // Puede rechazar aunque `fullscreenEnabled` diga que si (p.ej. si el navegador no
        // considera que haya habido gesto del usuario). No es terminal: cae al nivel 2, que
        // funciona igual de bien dentro de la ventana.
        console.warn('[ig-doorbell-card] pantalla completa nativa rechazada, se usa el respaldo propio', err);
      }
    }

    // Nivel 2: respaldo propio, `position:fixed` sobre el contenedor de la card.
    this._fsNative = false;
    this._fsActive = true;
    this._applyFullscreenUI();

    // Y ahora se COMPRUEBA que de verdad ha ocupado la ventana, en vez de darlo por hecho. Un
    // ancestro con transform/filter/perspective/contain:paint convierte cualquier position:fixed
    // descendiente en relativo A ESE ANCESTRO (comportamiento estandar de CSS, no un fallo del
    // navegador), y en Home Assistant un tema, card-mod o el propio cajon lateral pueden
    // introducir uno sin que la card se entere.
    if (this._fallbackFillsWindow()) { this._acquireWakeLock(); return; }

    // ...y si esta atrapado, NO se tira la toalla: se saca el contenedor a <body>, donde por
    // definicion no hay ningun ancestro que pueda atraparlo, y se vuelve a medir.
    //
    // Esto corrige un fallo REAL en el iPhone del usuario (2026-07-29): el icono desaparecia con
    // el uso normal. La version anterior, al fallar la medida, se limitaba a esconder el icono
    // PARA SIEMPRE -- y encima esconderlo dependia del sitio donde Home Assistant hubiera puesto
    // la card, no de nada que el usuario pudiera entender o cambiar. Una funcion que se
    // autodesactiva y no dice por que es peor que una que falla ruidosamente.
    //
    // Se mueve el CONTENEDOR, nunca el elemento propio de la card: sacar <ig-doorbell-card>
    // del DOM dispararia disconnectedCallback() y tumbaria la sesion WebRTC entera. El <video> se
    // mueve con el contenedor y no se corta: conserva su srcObject, y el traslado es sincrono, asi
    // que el elemento nunca llega a estar fuera del documento cuando el navegador comprueba si
    // debe pausarlo. Y como esta card no usa Shadow DOM, la hoja de estilos inyectada sigue
    // aplicando igual estando el contenedor colgado de <body>.
    //
    // El traslado solo ocurre cuando la via normal ya ha fallado: en el caso corriente no se toca
    // el DOM en absoluto.
    this._mark('pantalla completa: el respaldo esta atrapado por un ancestro - se traslada a <body> y se vuelve a medir');
    this._portalToBody();
    if (this._fallbackFillsWindow()) {
      console.info('[ig-doorbell-card] un ancestro atrapaba la pantalla completa; resuelto trasladando la card a <body>.');
      this._acquireWakeLock();
      return;
    }

    // Ni siquiera colgando de <body>. Eso ya no es "esta card en este hueco": es que en esta
    // pagina NINGUN elemento fijo puede ocupar la ventana (un transform sobre <html> o <body>).
    // Aqui si es un callejon sin salida honesto, y el icono se retira -- pero es un veredicto
    // sobre la PAGINA, estable, no algo que pueda cambiar porque el usuario abra el microfono.
    console.warn(
      '[ig-doorbell-card] la pantalla completa no es posible en esta pagina: ni siquiera ' +
      'colgando el contenedor de <body> se consigue ocupar la ventana. Causa habitual: un ' +
      'transform/filter/contain aplicado a <html> o <body> por un tema. Ancestros sospechosos: ' +
      JSON.stringify(this._suspiciousAncestors()) + '. Se retira el icono en vez de ofrecer un modo que no funciona.'
    );
    this._fsActive = false;
    this._applyFullscreenUI();
    this._fsUnavailable = true;
    this._paintFullscreenButton();
  }

  // Compara contra una SONDA, no contra ninguna medida del viewport: un elemento identico
  // (position:fixed, inset:0) colgado de <body>, medido en el mismo instante. Si el contenedor
  // acaba donde acaba la sonda, ha escapado.
  //
  // Se llego a esto midiendo, tras equivocarse DOS veces con medidas que parecen la referencia
  // obvia y no lo son:
  //  - window.innerWidth INCLUYE la barra de desplazamiento; el bloque contenedor de un
  //    position:fixed no. Medido en un Home Assistant real: una vista con scroll dio 1270x900
  //    contra una ventana de 1280x900 -- alto exacto, ancho corto en exactamente el grosor de la
  //    barra, y cero ancestros de riesgo.
  //  - documentElement.clientHeight tampoco sirve: en modo quirks devuelve el alto del DOCUMENTO,
  //    no el del viewport (medido: 4506px con una ventana de 900px de alto).
  _fallbackFillsWindow() {
    const rect = this.content.getBoundingClientRect();
    const probeEl = document.createElement('div');
    probeEl.style.cssText = 'position:fixed;inset:0;visibility:hidden;pointer-events:none;';
    document.body.appendChild(probeEl);
    const ref = probeEl.getBoundingClientRect();
    probeEl.remove();

    // Parte 2, y no es redundante: la sonda tiene un punto ciego que se ha visto DE VERDAD al
    // provocarlo (transform sobre <body>). Ahi la sonda queda atrapada exactamente igual que el
    // contenedor, los dos miden lo mismo, y la comparacion da "correcto" con una pantalla completa
    // de 64px de alto. Comparar lo mismo contra lo mismo detecta que el contenedor esta donde
    // deberia, pero no que ese sitio sea la ventana.
    //
    // Por eso se anade una cota de CORDURA sobre la propia sonda: si un elemento fijo colgado de
    // <body> no llega ni al 60% de la ventana, en esta pagina la posicion fija no funciona para
    // nadie. El 60% es holgado a proposito -- solo tiene que separar "la ventana entera" de "una
    // caja cualquiera", no medir con precision -- y se compara contra window.innerWidth/Height,
    // que aqui SI valen: la barra de desplazamiento son 10-17px y el modo quirks no les afecta.
    // Las dos trampas que estropearon la comparacion exacta no llegan ni de lejos a este margen.
    const probeIsSane = ref.height >= window.innerHeight * 0.6
      && ref.width >= window.innerWidth * 0.6;

    return probeIsSane
      && Math.abs(rect.width - ref.width) <= 2
      && Math.abs(rect.height - ref.height) <= 2
      && Math.abs(rect.left - ref.left) <= 2
      && Math.abs(rect.top - ref.top) <= 2;
  }

  // Diagnostico para cuando falla: nombra al culpable en vez de dejar un "no se pudo". Pensado
  // para leerse por depuracion remota desde la app companion, donde no hay DevTools a mano.
  _suspiciousAncestors() {
    const out = [];
    let n = this.content;
    let guard = 0;
    while (n && guard++ < 200) {
      if (n.nodeType === 1) {
        const cs = getComputedStyle(n);
        const offending = {};
        if (cs.transform && cs.transform !== 'none') offending.transform = cs.transform;
        if (cs.filter && cs.filter !== 'none') offending.filter = cs.filter;
        if (cs.perspective && cs.perspective !== 'none') offending.perspective = cs.perspective;
        if (cs.contain && cs.contain !== 'none') offending.contain = cs.contain;
        if (cs.willChange && cs.willChange !== 'auto') offending.willChange = cs.willChange;
        if (Object.keys(offending).length) out.push({ tag: n.tagName.toLowerCase(), ...offending });
      }
      n = n.parentNode || null;
      if (n && n.nodeType === 11) n = n.host;
    }
    return out;
  }

  // Traslado del CONTENEDOR a <body> y vuelta a su sitio. Se recuerda el hermano siguiente, no
  // solo el padre, para devolverlo exactamente donde estaba.
  _portalToBody() {
    if (this._fsHost) return;
    this._fsHome = { parent: this.content.parentNode, next: this.content.nextSibling };
    this._fsHost = document.createElement('div');
    this._fsHost.className = 'ig-fs-host';
    document.body.appendChild(this._fsHost);
    this._fsHost.appendChild(this.content);
  }

  _undoPortal() {
    if (!this._fsHost) return;
    if (this._fsHome && this._fsHome.parent) {
      this._fsHome.parent.insertBefore(this.content, this._fsHome.next);
    }
    this._fsHost.remove();
    this._fsHost = null;
    this._fsHome = null;
  }

  _exitFullscreen() {
    if (!this._fsActive) return;
    if (this._fsNative && currentFullscreenElement()) {
      // El repintado real lo hace _syncFullscreenFromBrowser() al llegar 'fullscreenchange' -
      // asi el camino "salgo yo" y el camino "sale el usuario con ESC" son el MISMO codigo y no
      // pueden divergir.
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      try { exit.call(document); } catch (err) { /* best effort */ }
      return;
    }
    this._fsActive = false;
    this._fsNative = false;
    this._applyFullscreenUI();
    this._releaseWakeLock();
  }

  // El navegador ha entrado o salido de pantalla completa por su cuenta (ESC, gesto del sistema,
  // otra pestaña...). Fuente de verdad: el propio documento, nunca nuestra variable.
  _syncFullscreenFromBrowser() {
    const fsEl = currentFullscreenElement();
    const weAreFullscreen = (fsEl === this);
    if (weAreFullscreen === (this._fsActive && this._fsNative)) return;
    if (weAreFullscreen) {
      this._fsActive = true;
      this._fsNative = true;
      this._applyFullscreenUI();
      this._acquireWakeLock();
    } else if (this._fsNative) {
      this._fsActive = false;
      this._fsNative = false;
      this._applyFullscreenUI();
      this._releaseWakeLock();
    }
  }

  // Un unico atributo (`data-fs`) gobierna TODO el reposicionado, para los dos niveles: asi la
  // hoja de estilos tiene una sola version del modo y no dos que puedan separarse con el tiempo.
  // `ig-fs-pseudo` solo anade el `position:fixed` que el nivel 1 no necesita (en nativo lo coloca
  // el navegador).
  // Las clases del modo van en el CONTENEDOR, no en el elemento de la card, y no es un detalle:
  // cuando hace falta trasladar el contenedor a <body> (ver _portalABody) deja de ser descendiente
  // del elemento, asi que cualquier regla colgada de `ig-doorbell-card[data-fs]` dejaria
  // de aplicar justo en el caso que se intenta salvar. El atributo `data-fs` SI se queda en el
  // elemento: en pantalla completa nativa es a el a quien dimensiona el navegador.
  _applyFullscreenUI() {
    if (this._fsActive) {
      this.setAttribute('data-fs', '1');
      this.content.classList.add('ig-fs');
      this.content.classList.toggle('ig-fs-pseudo', !this._fsNative);
      // Bloquear el scroll del documento por debajo solo tiene sentido en el respaldo (en nativo
      // el documento ya no se ve). Sin esto, un dedo sobre la card en el movil puede mover el
      // dashboard entero por detras.
      if (!this._fsNative) document.body.classList.add('ig-fs-body-lock');
    } else {
      // Devolver el contenedor a su sitio ANTES de quitar las clases, para que no llegue a verse
      // un fotograma con la card ya sin estilos de modo pero todavia colgando de <body>.
      this._undoPortal();
      this.removeAttribute('data-fs');
      this.content.classList.remove('ig-fs', 'ig-fs-pseudo');
      document.body.classList.remove('ig-fs-body-lock');
    }
    this._paintFullscreenButton();
    // El marco cambia de medida al entrar/salir, y con la imagen girada la caja del video se
    // calcula a partir de esa medida (§1.9). El ResizeObserver acabaria llegando, pero un frame
    // tarde: recalcular aqui evita el parpadeo. Ademas es aqui donde el carril lateral aparece o
    // desaparece, que solo depende del modo.
    this._layoutRotation();
  }

  _paintFullscreenButton() {
    if (!this.fsBtn) return;
    if (this._fsUnavailable) { this.fsBtn.style.display = 'none'; return; }
    this.fsBtn.style.display = '';
    const key = this._fsActive ? 'fs_exit' : 'fs_enter';
    this.fsBtn.setAttribute('title', getLocalText(this._hass, key));
    this.fsIcon.setAttribute('icon', this._fsActive ? 'mdi:fullscreen-exit' : 'mdi:fullscreen');
    this.fsBtn.classList.toggle('on', this._fsActive);
  }

  // Wake lock: la pantalla no se apaga mientras dura el modo. Best-effort a
  // proposito - no esta en todos los navegadores, exige contexto seguro, y el sistema puede
  // revocarlo. Que falle no debe impedir la pantalla completa, solo que la pantalla se apague
  // como siempre.
  async _acquireWakeLock() {
    if (this._wakeLock || !navigator.wakeLock) return;
    try {
      this._wakeLock = await navigator.wakeLock.request('screen');
      // El sistema lo revoca al minimizar la app o cambiar de pestaña; hay que volver a pedirlo
      // al regresar o la pantalla se apagaria a mitad de conversacion en la segunda vuelta.
      this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
      this._armIdleWakeLockTimer();
      if (!this._onVisibilityForWakeLock) {
        this._onVisibilityForWakeLock = () => {
          if (document.visibilityState === 'visible' && this._fsActive) this._acquireWakeLock();
        };
        document.addEventListener('visibilitychange', this._onVisibilityForWakeLock);
      }
    } catch (err) {
      console.warn('[ig-doorbell-card] no se pudo mantener la pantalla encendida (wake lock)', err);
    }
  }

  // ── Soltar la pantalla por inactividad ──────────────────────────────────────────────────────
  //
  // Se escucha en la PROPIA card y no en `document`: un toque en otra parte del panel no es mirar
  // el portero, y contarlo mantendria la pantalla encendida por algo que no tiene que ver.
  // `pointerdown` cubre dedo y raton; `keydown` va en document porque el teclado no tiene posicion.
  // ⚠️ `reiniciar` DISTINGUE LAS DOS LLAMADAS, Y CONFUNDIRLAS ROMPIA ESTO ENTERO (2026-09-06).
  //
  // Esta cuenta atras mide **tiempo sin que nadie toque**, y hasta ahora se reiniciaba cada vez que
  // se conseguia el wake lock -- o sea en cada (re)conexion del stream. Medido en la tablet por la
  // sesion de HASS: con `idle_release_seconds: 15` funcionaba y con `60` NO disparaba nunca, porque
  // el stream renegocia hacia los 30-45 s y le devolvia la cuenta a cero. Con 15 daba tiempo a
  // saltar antes del primer reconecte; con 60, jamas.
  //
  // Lo que lo hacia dificil de ver es que el sintoma dependia del VALOR configurado, asi que parecia
  // «va con 15 y no con 60» -- que se lee como un problema de duracion y no de disparador.
  //
  // Solo la interaccion reinicia. El ciclo de vida del stream arma la cuenta si no habia ninguna,
  // pero no la toca si ya esta corriendo.
  _armIdleWakeLockTimer(restartClock = false) {
    if (restartClock) LAST_INTERACTION_MS = Date.now();
    this._clearIdleWakeLockTimer();
    if (!this._idleReleaseMs) return;                 // 0 = desactivado (telefonos)
    this._registerIdleActivityListeners();
    // El plazo es ABSOLUTO desde la ultima interaccion real, no desde esta llamada. Rearmarlo no
    // regala tiempo, y una instancia recien creada hereda lo que de verdad queda.
    const secondsLeft = this._idleReleaseMs - (Date.now() - LAST_INTERACTION_MS);
    this._idleWakeLockTimer = setTimeout(() => {
      this._idleWakeLockTimer = null;
      // ⚠️ SOLTAR EL WAKE LOCK NO BASTA, Y LA v1.4.0 SE QUEDO EN ESO (2026-09-06).
      //
      // Medido en la tablet: con la card visible y NADIE tocando, a los 2m22s seguian retenidos
      // `SCREEN_BRIGHT_WAKE_LOCK` y `PARTIAL_WAKE_LOCK 'AudioMix'`, y la pantalla sin apagarse --
      // con `screen_off_timeout` en 60 s.
      //
      // El motivo: **un `<video>` reproduciendose mantiene la pantalla encendida por su cuenta**.
      // Es un keep-awake implicito del navegador, independiente de `navigator.wakeLock`, asi que
      // soltar el nuestro no cambia nada mientras haya video corriendo. Por eso ocultar la card SI
      // funcionaba (ahi se para el video) y quedarse quieto NO.
      //
      // La accion correcta al agotarse la espera es la MISMA que al ocultarse: soltar el stream
      // entero. Y ademas es lo que Inaki pidio de verdad -- «apagar la pantalla Y dejar de consumir
      // el stream», no solo lo primero.
      if (!this.pc && !this._reconnecting) return;
      console.info('[ig-doorbell-card] sin interacción: se suelta el vídeo para que la pantalla pueda apagarse');
      this._streamPausedByHide = true;      // mismo camino de vuelta que al ocultarse
      this._clearReconnectTimer();
      this._reconnecting = false;
      this._teardownConnectionObjects();
      this._releaseWakeLock();
      if (this.micButton) this._setLiveState('connecting');
      if (this.loader) this.loader.style.opacity = '1';
    }, Math.max(0, secondsLeft));
  }

  _clearIdleWakeLockTimer() {
    if (this._idleWakeLockTimer) { clearTimeout(this._idleWakeLockTimer); this._idleWakeLockTimer = null; }
  }

  _registerIdleActivityListeners() {
    if (this._onIdleActivity) return;
    this._onIdleActivity = () => {
      // Tocar devuelve la pantalla: si el lock ya se habia soltado se vuelve a pedir, y si sigue
      // puesto solo se reinicia la cuenta. Nunca se pide con la pagina oculta -- ahi el navegador
      // lo rechazaria, y ademas seria pedir pantalla para nadie.
      if (document.visibilityState !== 'visible') return;
      // Si la espera ya se habia agotado y solto el video, tocar lo repone -- igual que volver a
      // ser visible. Sin esto, quien tocara la pantalla se encontraria la card en negro.
      if (this._streamPausedByHide && this.isConnected && this.content && !this.pc) {
        this._streamPausedByHide = false;
        this.startWebRTC();
        return;
      }
      LAST_INTERACTION_MS = Date.now();
      if (!this._wakeLock) this._acquireWakeLock(); else this._armIdleWakeLockTimer(true);
    };
    this.addEventListener('pointerdown', this._onIdleActivity, { passive: true });
    document.addEventListener('keydown', this._onIdleActivity, { passive: true });
  }

  _unregisterIdleActivityListeners() {
    if (!this._onIdleActivity) return;
    this.removeEventListener('pointerdown', this._onIdleActivity);
    document.removeEventListener('keydown', this._onIdleActivity);
    this._onIdleActivity = null;
  }

  _releaseWakeLock() {
    this._clearIdleWakeLockTimer();
    if (this._wakeLock) {
      try { this._wakeLock.release(); } catch (err) { /* best effort */ }
      this._wakeLock = null;
    }
    if (this._onVisibilityForWakeLock) {
      document.removeEventListener('visibilitychange', this._onVisibilityForWakeLock);
      this._onVisibilityForWakeLock = null;
    }
  }

  // ==============================================================================
  // Visibilidad del boton de abrir. Fuente de verdad: el `door_m` que el portero manda en cada
  // `session_info`. La red de seguridad de aprenderlo fallando SOLO se usa mientras ese dato no
  // haya llegado nunca - o sea, contra un firmware anterior a que existiera el campo.
  // ==============================================================================
  _applyDoorAvailability() {
    if (!this.unlockButton) return;
    // Con `unlock_entity` configurada la apertura NO pasa por el portero, sino por una entidad de
    // Home Assistant: lo que el portero opine de su propia cerradura es irrelevante ahi.
    const hide = !this.config.unlock_entity && (
      (this._doorMode !== null)
        ? this._doorMode === 2          // dato autoritativo del portero: manda siempre
        : this._noLockLegacy            // firmware anterior: lo unico que se sabe es que fallo
    );
    const action = this.unlockButton.closest('.action') || this.unlockButton;
    action.style.display = hide ? 'none' : '';
    // Un boton que desaparece mientras esta "armado" dejaria el estado de confirmacion colgado.
    if (hide) this._disarmDoorConfirm();
  }

  // ==============================================================================
  // ABRIR LA PUERTA EXIGE CONFIRMACION (API_CONTRACT.md §1.8, 2026-07-30)
  //
  // Doble pulsacion con estado visible, no "deslizar para confirmar". El contrato descarta el
  // deslizamiento por tres motivos que se aplican de lleno a esta card: se usa con RATON (la card
  // vive en dashboards de PC), los gestos de arrastre son un problema conocido para TalkBack/
  // VoiceOver/control por conmutador, y en una tablet de pared en vertical el deslizamiento
  // horizontal compite con los gestos del sistema. El precedente es la cerradura Aqara en el
  // propio Home Assistant, que hace exactamente esto.
  //
  // Y es un mensaje EN LINEA, no un dialogo modal: un modal que hay que descartar con alguien
  // esperando en la puerta tapa ademas el video, que es justo lo que el usuario esta mirando para
  // decidir si abre.
  //
  // Las tres reglas sin las cuales esto da sensacion de seguridad sin darla:
  //  1. CADUCA a los ~3s. Sin esto una pulsacion accidental deja la puerta ARMADA y la siguiente
  //     -igual de accidental- la abre: peor que no tener nada.
  //  2. Un doble toque RAPIDO no vale (minimo ~300ms). Un movil en el bolsillo, un niño o un dedo
  //     que rebota producen exactamente un doble toque.
  //  3. Tras abrir se vuelve al estado normal, nunca a "confirmando".
  // ==============================================================================
  _onDoorPress() {
    const now = Date.now();
    if (!this._doorArmedAt) { this._armDoorConfirm(); return; }
    // Regla 2: por debajo del umbral no se cuenta como confirmacion NI se desarma - un rebote no
    // debe obligar al usuario a empezar de cero, solo no debe abrir.
    if (now - this._doorArmedAt < 300) return;
    this._disarmDoorConfirm();
    if (!this.config.unlock_entity) this.triggerNativeOpen();
    else this.triggerUnlock();
  }

  _armDoorConfirm() {
    this._doorArmedAt = Date.now();
    if (this.unlockButton) this.unlockButton.classList.add('confirming');
    if (this.unlockIcon) this.unlockIcon.setAttribute('icon', 'mdi:help-circle-outline');
    if (this.unlockLabel) {
      this.unlockLabel.textContent = getLocalText(this._hass, 'lbl_door_confirm');
      this.unlockLabel.classList.add('on-amber');
    }
    this._flashStatusLine('door_confirm', 3000);
    if (this._doorArmTimer) clearTimeout(this._doorArmTimer);
    this._doorArmTimer = setTimeout(() => this._disarmDoorConfirm(), 3000);
  }

  _disarmDoorConfirm() {
    if (this._doorArmTimer) { clearTimeout(this._doorArmTimer); this._doorArmTimer = null; }
    if (!this._doorArmedAt) return;
    this._doorArmedAt = 0;
    if (this.unlockButton) this.unlockButton.classList.remove('confirming');
    // Solo se devuelve el icono/etiqueta de reposo si la puerta no esta abierta ahora mismo: si
    // esto se llama justo antes de abrir, quien manda es triggerNativeOpen()/triggerUnlock().
    const isOpen = this.unlockButton && this.unlockButton.classList.contains('active-unlock');
    if (!isOpen) {
      if (this.unlockIcon) this.unlockIcon.setAttribute('icon', 'mdi:key');
      if (this.unlockLabel) this.unlockLabel.classList.remove('on-amber');
      this._setDoorLabel(false);
    }
  }

  // ==============================================================================
  // SONIDO DEL CLIENTE (API_CONTRACT.md §1.10, 2026-07-30)
  //
  // Lo que esta regla NO es, y confundirlo dejaria al usuario sordo justo cuando hay alguien en la
  // puerta: NO es "silencio hasta que hables". Escuchar y hablar son ejes independientes - se oye
  // al visitante y LUEGO se decide si contestar. Por eso el altavoz tiene su propio control,
  // separado del boton de micro.
  //
  // Tampoco afecta a las grabaciones: un evento se graba con sonido siempre. Lo que se silencia es
  // la reproduccion en vivo de un cliente que solo esta mirando.
  //
  // Limitacion real del navegador que obliga a este diseño: el <video> nace `muted` por
  // OBLIGACION (politica de autoplay - con sonido, play() seria rechazado y no habria ni imagen),
  // asi que desmutear siempre necesita una activacion del usuario en la pagina. Cuando el intento
  // falla no se finge que ha funcionado: se vuelve a mudo y se dice que hay que tocar el altavoz.
  // ==============================================================================
  _setAudioOn(on, reason) {
    const wantOn = !!on;
    this._audioOn = wantOn;
    if (this.videoEl) {
      this.videoEl.muted = !wantOn;
      if (wantOn && typeof this.videoEl.play === 'function') {
        // Desmutear sin activacion del usuario puede hacer que el navegador PAUSE el elemento en
        // vez de lanzar un error - de ahi el play() y su catch.
        const p = this.videoEl.play();
        if (p && typeof p.catch === 'function') {
          p.catch(() => {
            this.videoEl.muted = true;
            this._audioOn = false;
            this._paintAudioState();
            this._flashStatusLine('snd_blocked', 5000);
            console.warn(`[ig-doorbell-card] el navegador no permitio activar el sonido (motivo="${reason}") - hace falta que el usuario toque el control de altavoz`);
          });
        }
      }
    }
    this._paintAudioState();
  }

  _paintAudioState() {
    if (this.volIcon) this.volIcon.setAttribute('icon', this._audioOn ? 'mdi:volume-high' : 'mdi:volume-off');
    if (this.sndBtn) {
      this.sndBtn.classList.toggle('on', !!this._audioOn);
      this.sndBtn.setAttribute('title', getLocalText(this._hass, this._audioOn ? 'snd_on' : 'snd_off'));
      this.sndBtn.setAttribute('aria-pressed', this._audioOn ? 'true' : 'false');
    }
  }

  // El timbre es el unico motivo por el que el sonido se enciende SOLO (§1.10): es el momento para
  // el que existe el aparato. La señal no viaja por la señalizacion WebRTC, asi que se lee de una
  // entidad de Home Assistant que el usuario configura (`ring_entity`).
  //
  // ⚠️ DE DONDE SALE ESA ENTIDAD CAMBIO EL 2026-08-24, y este comentario decia lo de antes: la
  // publicaba el firmware por MQTT (`videoportero/timbre`). MQTT se retiro (§4) y ahora la crea la
  // integracion de Home Assistant, como **una entidad de tipo `event`** -- la de eventos, que lleva
  // todo lo que el portero cuenta. Aqui no cambia nada, porque la rama de `event` de mas abajo ya
  // existia; lo que cambia es que hay que configurar ESA, y que un `binary_sensor` de timbre de
  // los de antes se quedara sin actualizarse.
  //
  // Se admiten las dos formas que puede tener esa entidad: un `binary_sensor` (transicion a 'on')
  // y un `event` (cuyo `state` es la marca de tiempo del ultimo evento, no 'on'/'off' - tratarlo
  // como binario no dispararia nunca).
  _updateRingState() {
    const entityId = this.config.ring_entity;
    if (!entityId || !this._hass) { this._ringMarker = null; return; }
    const stateObj = this._hass.states[entityId];
    if (!stateObj) { this._ringMarker = null; return; }
    const isEvent = entityId.split('.')[0] === 'event';
    const marker = isEvent ? String(stateObj.state) : (stateObj.state === 'on' ? 'on' : 'off');
    const prevMarker = this._ringMarker;
    this._ringMarker = marker;
    // Primera lectura: NO dispara. Al abrir el dashboard, un binary_sensor que lleva rato en 'on'
    // (o un event con una marca vieja) no es una llamada de ahora.
    if (prevMarker === null || prevMarker === undefined) return;
    const hasRung = isEvent
      ? (marker !== prevMarker && marker !== 'unknown' && marker !== 'unavailable')
      : (marker === 'on' && prevMarker !== 'on');
    if (!hasRung) return;
    if (this._audioOn) return; // ya se estaba oyendo: nada que anunciar
    this._setAudioOn(true, 'timbre');
    if (this._audioOn) this._flashStatusLine('snd_ring', 6000);
  }

  // ==============================================================================
  // GIRO DE LA IMAGEN (API_CONTRACT.md §1.9, 2026-07-30)
  //
  // `rot` son GRADOS EN SENTIDO HORARIO QUE APLICA EL CLIENTE, y CSS `rotate()` tambien gira en
  // sentido horario: el mapeo es directo, sin conversion.
  //
  // Con 90/270 el ancho y el alto se intercambian, y eso no se puede expresar en CSS puro sin
  // conocer la medida del contenedor - de ahi el calculo en JS con un ResizeObserver. El
  // `object-fit: contain` de siempre sigue haciendo el letterboxing dentro de la caja ya girada.
  //
  // Lo que NO se hace, y es lo importante: recortar para llenar. Un zoom hasta cubrir el ancho
  // tira la parte de arriba y la de abajo, que es exactamente lo que se gano girando el sensor.
  // Seria deshacer el cambio.
  // ==============================================================================
  _rotStorageKey() {
    return `ig-doorbell-rot-${this.config && this.config.device_id ? this.config.device_id : 'no-id'}`;
  }

  _recallRotation() {
    try {
      const savedValue = localStorage.getItem(this._rotStorageKey());
      const n = savedValue === null ? null : parseInt(savedValue, 10);
      if (n === 0 || n === 90 || n === 180 || n === 270) return n;
    } catch (err) { /* localStorage puede estar bloqueado; no es motivo para no funcionar */ }
    return 90; // primera vez y solo la primera vez: el montaje del producto es vertical
  }

  _rememberRotation(rot) {
    try { localStorage.setItem(this._rotStorageKey(), String(rot)); } catch (err) { /* idem */ }
  }

  _applyRotation(rot) {
    if (rot !== 0 && rot !== 90 && rot !== 180 && rot !== 270) {
      // Un valor raro se ignora en vez de pintarse: pintar torcido sin que nada lo explique es
      // peor que no girar. Mismo criterio que el firmware, que tampoco lo guarda (§1.9).
      console.warn(`[ig-doorbell-card] "rot" con un valor no admitido (${rot}) - se ignora, se mantiene ${this._rot}°`);
      return;
    }
    const rotChanged = (rot !== this._rot) || !this._rotConfirmed;
    this._rot = rot;
    this._rotConfirmed = true;
    this._rememberRotation(rot);
    if (!rotChanged) return;
    if (this.feedWrap) this.feedWrap.setAttribute('data-rot', String(rot));
    // SIN animacion, a proposito (§1.9): una transicion animada convierte un error de una sola vez
    // en un efecto que parece intencionado y se repite en cada arranque.
    this._applyFeedAspect();
    this._layoutRotation();
  }

  // Forma del marco de video. Con la imagen en vertical la card deja de ser 16:9 y pasa a 9:16 -
  // que es lo que hace que el video se vea GRANDE en un movil en vertical, el caso normal de
  // atender un timbre. El tope de altura evita el absurdo de una card de 2000px en un panel ancho:
  // ahi el video se centra y sobra espacio a los lados, que es el caso que §1.9 resuelve con el
  // carril lateral (ver _layoutRotation).
  _applyFeedAspect() {
    if (!this.feedWrap) return;
    const vertical = (this._rot === 90 || this._rot === 270);
    if (this.config.height && this.config.height !== 'auto') {
      this.feedWrap.style.height = this.config.height;
      this.feedWrap.style.aspectRatio = 'unset';
      this.feedWrap.style.maxHeight = '';
      return;
    }
    this.feedWrap.style.height = 'auto';
    this.feedWrap.style.aspectRatio = vertical ? '9/16' : '16/9';
    this.feedWrap.style.maxHeight = vertical ? '72vh' : '';
  }

  // Ancho del carril lateral de §1.9. ESTRECHO: solo lo que ocupa el objetivo tactil, porque el
  // ancho que se lleva el carril es alto que pierde el video.
  static get RAIL_WIDTH() { return 104; }

  _layoutRotation() {
    if (!this.videoEl || !this.feedWrap) return;
    const v = this.videoEl;
    const w = this.feedWrap.clientWidth;
    const h = this.feedWrap.clientHeight;
    const vertical = (this._rot === 90 || this._rot === 270);

    // Carril lateral (§1.9 + §1.7): video vertical dentro de un marco APAISADO. El caso real es una
    // tablet de pared, que vive en apaisado permanentemente. Solo en pantalla completa, que es
    // donde los botones ya flotan sobre la imagen; en el modo normal viven debajo del video y
    // moverlos encima seria un cambio de diseño distinto, no este.
    const rail = !!this._fsActive && vertical && w > h * 1.05;
    if (this.content) this.content.classList.toggle('ig-rail', rail);

    if (!vertical) {
      v.style.width = '';
      v.style.height = '';
      v.style.position = '';
      v.style.left = '';
      v.style.top = '';
      v.style.transform = this._rot === 180 ? 'rotate(180deg)' : '';
      return;
    }
    if (!w || !h) return; // aun sin layout (card oculta, pestaña en segundo plano): ya volvera el RO

    // La caja se declara con el ancho y el alto INTERCAMBIADOS y se gira sobre su centro: tras el
    // giro ocupa exactamente el hueco disponible, y `object-fit: contain` centra dentro la imagen
    // vertical sin recortar nada.
    const usableWidth = Math.max(80, w - (rail ? IgDoorbellCard.RAIL_WIDTH : 0));
    v.style.position = 'absolute';
    v.style.width = `${h}px`;
    v.style.height = `${usableWidth}px`;
    v.style.left = `${usableWidth / 2}px`;
    v.style.top = '50%';
    v.style.transform = `translate(-50%, -50%) rotate(${this._rot}deg)`;
  }

  render() {
    if (!this.content) {
      // Lenguaje visual alineado con el mockup real de Figma (android_app/ios_app, 2026-07-10 -
      // ver COORDINATION.md Q22-bis en ig_hassio_addons): paleta exacta, marco de video
      // redondeado con HUD superpuesto DENTRO del propio video (EN VIVO + hora, "Audio activo",
      // "Movimiento detectado"), botones de accion asimetricos (mic protagonista/puerta
      // secundario), linea de estado bajo el video, y chips de modo. Los elementos del mockup
      // que NO aplican a una card de HA (selector de dispositivo, cabecera de branding, fila de
      // accesos a "pantallas") se han dejado fuera a proposito, ver esa misma entrada.
      this.innerHTML = `
        <ha-card>
          <div class="ig-container">

            <div class="mode-row" id="mode-row" style="display:none;"></div>

            <div class="feed-wrap" data-state="connecting">
              <div class="ig-loader-overlay" id="ig-loader">
                <div class="ig-ring"></div>
                <div class="ig-logo">IG</div>
              </div>

              <div class="video-wrapper">
                <video id="video-player" autoplay playsinline muted></video>
              </div>

              <div class="hud-top">
                <div class="hud-top-left">
                  <div class="live-tag" id="live-tag" data-state="connecting">
                    <div class="reddot"></div>
                    <span class="status-badge">${getLocalText(this._hass, 'connecting')}</span>
                  </div>
                  <!-- Contador de clientes WebRTC (API_CONTRACT.md §1.4-ter #2, mensaje
                       session_info). Oculto mientras el dispositivo no lo haya mandado NUNCA -
                       un firmware anterior al contrato no lo manda, y un "1" inventado seria
                       peor que no enseñar nada. -->
                  <div class="clients-pill" id="clients-pill" style="display:none;" title="${getLocalText(this._hass, 'clients_tip')}">
                    <ha-icon icon="mdi:account-multiple"></ha-icon>
                    <span id="clients-count">1</span>
                  </div>
                </div>
                <div class="hud-time" id="hud-time">
                  <div class="hm" id="hud-time-hm">--:--</div>
                  <div class="ymd" id="hud-time-date">--/--/--</div>
                </div>
              </div>

              <div class="motion-pill" id="motion-pill" style="display:none;">
                <ha-icon icon="mdi:motion-sensor"></ha-icon>
                <span>${getLocalText(this._hass, 'motion_detected')}</span>
              </div>

              <div class="hud-bottom">
                <div class="audio-pill" id="audio-pill" style="display:none;">
                  <ha-icon icon="mdi:microphone"></ha-icon>
                  <span>${getLocalText(this._hass, 'audio_active')}</span>
                </div>
                <div class="hud-bottom-right">
                  <!-- Selector de calidad por destinatario (API_CONTRACT.md §1.4-ter #3). Solo
                       aparece cuando el dispositivo ha CONFIRMADO al menos un quality_state (ver
                       _probeQualitySupport): un firmware anterior al contrato ignora el mensaje
                       'quality' en silencio, y un selector que no hace nada seria un boton que
                       miente. El menu se pinta desde QUALITY_MODES en _renderQualityMenu(). -->
                  <div class="hud-quality" id="hud-quality" style="display:none;">
                    <button type="button" class="q-btn" id="q-btn" title="${getLocalText(this._hass, 'q_label')}">
                      <ha-icon id="q-icon" icon="mdi:auto-fix"></ha-icon>
                      <span id="q-label">${getLocalText(this._hass, 'q_auto')}</span>
                    </button>
                    <div class="q-menu" id="q-menu" style="display:none;"></div>
                  </div>
                  <!-- Control de sonido (API_CONTRACT.md §1.10). El altavoz de este lado arranca
                       MUDO: ver no es escuchar. El icono es un BOTON de verdad, no un adorno junto
                       al deslizador - antes el deslizador cambiaba el volumen de un elemento que
                       seguia mudo, o sea un control que mentia: subirlo no hacia sonar nada. -->
                  <div class="hud-vol" id="hud-vol">
                    <button type="button" class="snd-btn" id="snd-btn" aria-pressed="false" title="${getLocalText(this._hass, 'snd_off')}">
                      <ha-icon icon="mdi:volume-off" id="vol-icon"></ha-icon>
                    </button>
                    <input type="range" id="vol-slider" min="0" max="1" step="0.05" value="1">
                  </div>
                  <div class="hud-sig" id="hud-sig"><i></i><i></i><i></i><i></i></div>
                  <!-- Pantalla completa. Ultimo del cluster derecho, que es donde lo
                       espera cualquiera que haya usado un reproductor de video. Sigue visible
                       DENTRO del modo (cambiando a "salir"): es la unica salida garantizada,
                       porque ESC solo existe si hay teclado y el respaldo CSS no tiene la salida
                       del navegador. -->
                  <button type="button" class="hud-fs" id="fs-btn" title="${getLocalText(this._hass, 'fs_enter')}">
                    <ha-icon id="fs-icon" icon="mdi:fullscreen"></ha-icon>
                  </button>
                </div>
              </div>
            </div>

            <div class="status-line" id="status-line">${getLocalText(this._hass, 'idle_status')}</div>

            <div class="actions-row">
              <div class="action">
                <button id="mic-button" class="btn mic" disabled>
                  <div class="pulsering"></div>
                  <ha-icon icon="mdi:microphone-off"></ha-icon>
                </button>
                <span class="lbl" id="mic-lbl">${getLocalText(this._hass, 'lbl_mic_off')}</span>
              </div>
              <div class="action">
                <button id="unlock-button" class="btn door" disabled>
                  <ha-icon icon="mdi:key"></ha-icon>
                </button>
                <span class="lbl" id="unlock-lbl">${getLocalText(this._hass, 'lbl_door_idle')}</span>
              </div>
            </div>

          </div>
        </ha-card>
      `;

      this.content = this.querySelector('.ig-container');
      this.feedWrap = this.querySelector('.feed-wrap');
      this.videoEl = this.querySelector('#video-player');
      this.micButton = this.querySelector('#mic-button');
      this.micIcon = this.querySelector('#mic-button ha-icon');
      this.micLabel = this.querySelector('#mic-lbl');
      this.badge = this.querySelector('.status-badge');
      this.liveTag = this.querySelector('#live-tag');
      this.audioPill = this.querySelector('#audio-pill');
      this.motionPill = this.querySelector('#motion-pill');
      this.statusLine = this.querySelector('#status-line');
      this.modeRow = this.querySelector('#mode-row');
      this.unlockButton = this.querySelector('#unlock-button');
      this.unlockIcon = this.querySelector('#unlock-button ha-icon');
      this.unlockLabel = this.querySelector('#unlock-lbl');
      this.volSlider = this.querySelector('#vol-slider');
      this.volIcon = this.querySelector('#vol-icon');
      this.sndBtn = this.querySelector('#snd-btn');
      this.loader = this.querySelector('#ig-loader');
      this.hudTimeHm = this.querySelector('#hud-time-hm');
      this.hudTimeDate = this.querySelector('#hud-time-date');
      this.clientsPill = this.querySelector('#clients-pill');
      this.clientsCount = this.querySelector('#clients-count');
      this.qualityCtl = this.querySelector('#hud-quality');
      this.qualityBtn = this.querySelector('#q-btn');
      this.qualityIcon = this.querySelector('#q-icon');
      this.qualityLabel = this.querySelector('#q-label');
      this.qualityMenu = this.querySelector('#q-menu');
      this.fsBtn = this.querySelector('#fs-btn');
      this.fsIcon = this.querySelector('#fs-icon');

      // Pantalla completa. El click va con stopPropagation por el mismo motivo que el
      // selector de calidad: hay un listener a nivel de documento que cierra su menu.
      this.fsBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._toggleFullscreen();
      });
      // El vigilante de vida solo mira cada 5s, y el chip de estado no deberia pasarse 5s
      // mintiendo. 'timeupdate' del propio <video> avisa varias veces por segundo en cuanto la
      // imagen avanza de verdad, que es exactamente la señal que debe mandar aqui. El coste es
      // una comparacion de cadenas: _confirmLiveFromMedia() sale en la primera linea salvo que el
      // chip este realmente equivocado.
      this.videoEl.addEventListener('timeupdate', () => this._confirmLiveFromMedia());

      this._registerFullscreenListeners();
      this._applyDoorAvailability();

      this._renderQualityMenu();
      this.qualityBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._toggleQualityMenu();
      });
      // Cerrar el menu al tocar en cualquier otro sitio (incluido el propio video) - un popup
      // sobre el video que no se cierra solo tapa la imagen, justo lo que el usuario quiere ver.
      this._onDocClickForQuality = () => { if (this._qualityMenuOpen) this._toggleQualityMenu(false); };
      document.addEventListener('click', this._onDocClickForQuality);

      // Reloj superpuesto arriba-dcha (HH:MM + fecha, mono) - decorativo (hora del propio
      // navegador, no del dispositivo), pero es parte real del HUD del mockup Figma (valores
      // exactos confirmados 2026-07-10, ver COORDINATION.md Q22-bis). Corre siempre, independiente
      // del estado de conexion - se para solo en disconnectedCallback() (la card sale del DOM).
      this._updateHudClock();
      this._hudClockTimer = setInterval(() => this._updateHudClock(), 1000);

      // El "alto configurable" aplica al MARCO DE VIDEO (.feed-wrap), no a la card entera - la
      // card ahora tiene ademas la fila de modo/linea de estado/botones fuera del video, que
      // deben conservar su alto natural en vez de comprimirse dentro de la medida pensada solo
      // para el video. La forma (16:9 o 9:16) la decide el giro conocido, ver _applyFeedAspect().
      this.feedWrap.setAttribute('data-rot', String(this._rot));
      this._applyFeedAspect();
      this._layoutRotation();

      // El giro con 90/270 intercambia ancho y alto, y eso no se puede escribir en CSS sin conocer
      // la medida real del marco - de ahi el observador. Dispara solo cuando el layout cambia de
      // verdad (redimensionar la ventana, cambiar de vista, entrar en pantalla completa), no en
      // cada frame de video.
      if (typeof ResizeObserver === 'function') {
        this._feedRO = new ResizeObserver(() => this._layoutRotation());
        this._feedRO.observe(this.feedWrap);
      } else {
        this._onWindowResizeForRot = () => this._layoutRotation();
        window.addEventListener('resize', this._onWindowResizeForRot);
      }

      // Camino primario: mensaje de senalizacion nativo 'open'/'open_result' (API_CONTRACT.md
      // §3.3, funciona igual local y remoto). unlock_entity sigue disponible como alternativa
      // explicita si el usuario prefiere que la apertura pase por una entidad/Automatizacion de
      // HA (logging propio, condiciones, etc.) - ver ARCHITECTURE.md §5 en ig_hassio_addons.
      // Doble pulsacion (§1.8): el click NO abre, arma; el segundo abre. Ver _onDoorPress().
      this.unlockButton.addEventListener('click', () => this._onDoorPress());

      this.micButton.addEventListener('click', () => this.toggleTalk());

      // El deslizador guarda el VOLUMEN; encender o apagar el sonido es el boton de al lado
      // (§1.10). Son dos cosas distintas y hasta ahora estaban confundidas en una: el volumen se
      // recordaba entre sesiones y el sonido nacia mudo, asi que el usuario veia el deslizador al
      // maximo y no oia nada. El volumen se sigue recordando; el sonido, deliberadamente NO.
      const savedVol = localStorage.getItem('ig-doorbell-vol') || '1';
      this.volSlider.value = savedVol;
      this._paintAudioState();

      this.sndBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        // Subir el sonido con el volumen a cero no haria nada y pareceria una averia.
        if (!this._audioOn && parseFloat(this.volSlider.value) === 0) {
          this.volSlider.value = '1';
          this.videoEl.volume = 1;
          localStorage.setItem('ig-doorbell-vol', '1');
        }
        this._setAudioOn(!this._audioOn, 'usuario');
      });

      this.volSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this.videoEl.volume = val;
        localStorage.setItem('ig-doorbell-vol', String(val));
        // Mover el deslizador ES una accion explicita del usuario sobre el sonido, asi que vale
        // como "abrir el audio" - y ademas es el gesto que el navegador exige para desmutear.
        if (val > 0 && !this._audioOn) this._setAudioOn(true, 'deslizador');
        else if (val === 0 && this._audioOn) this._setAudioOn(false, 'deslizador');
        else this._paintAudioState();
      });

      this.injectStyles();
      this._updateHassBoundUI();
      this.startWebRTC();
    }
  }

  async startWebRTC() {
    // Reutiliza la misma limpieza que disconnectedCallback()/_scheduleReconnect() - defensivo
    // ademas contra el vigilante de vida quedando "colgado" de una sesion anterior si esta
    // funcion se llama de nuevo por otro motivo (p.ej. HA re-renderiza la card).
    this._teardownConnectionObjects();
    await this.startNativeSession();
  }

  // ==============================================================================
  // Habla el protocolo propio del doorbell (ICE-Lite + DTLS-SRTP + RTP), directo o vía relay.
  // Credenciales/host servidos por la integracion ig_doorbell
  // via la API interna de WebSocket de HA (nunca pegados a mano en YAML). Ver
  // API_CONTRACT.md §1.4/§3.2/§3.3 (IG_Doorbell) y ARCHITECTURE.md §5 (ig_hassio_addons).
  // ==============================================================================

  // Instrumentacion real con timestamps (anadida 2026-07-10, ver COORDINATION.md - reporte real
  // del usuario: 10+s para el primer frame con la card nueva, frente a ~1s con la card antigua
  // via go2rtc). _mark() deja en consola cada paso con el tiempo transcurrido desde que arranco
  // ESTA sesion concreta - pensado para diagnosticar con datos reales, no adivinando, donde se
  // va el tiempo. Bajar de nivel/quitar una vez cerrado el problema de rendimiento real.
  _mark(label) {
    if (!this._t0) return;
    const elapsed = Math.round(performance.now() - this._t0);
    console.log(`[ig-doorbell-card timing] +${elapsed}ms  ${label}`);
  }

  // Libera el slot WebRTC de verdad al cerrar/recargar/navegar fuera de la pagina, en vez de
  // dejar que el doorbell lo desaloje solo tras su timeout de abandono (~45s) - mismo patron que
  // ya usa el propio dashboard web del doorbell contra este mismo endpoint (encontrado real,
  // 2026-07-10, ver COORDINATION.md). `disconnectedCallback()` (mas abajo) YA manda 'bye' cuando
  // HA quita esta card del DOM (p.ej. al cambiar de vista de Lovelace dentro de la misma pagina)
  // pero ese hook de Custom Elements NO esta garantizado durante un cierre de pestaña/ventana o
  // una recarga completa - el runtime de JS puede desaparecer antes de que llegue a ejecutarse.
  // 'pagehide' SI esta pensado para esto, y unido a sendBeacon (para el camino local, que usa
  // POST/fetch normal - un fetch() en marcha se cancela al desaparecer la pagina, sendBeacon esta
  // diseñado especificamente para completarse durante el unload) cierra el hueco real.
  _registerUnloadHandler() {
    if (this._onPageHide) return; // ya registrado, evita duplicados si se reconecta
    this._onPageHide = () => this._sendByeOnUnload();
    window.addEventListener('pagehide', this._onPageHide);
  }

  _unregisterUnloadHandler() {
    if (!this._onPageHide) return;
    window.removeEventListener('pagehide', this._onPageHide);
    this._onPageHide = null;
  }

  _sendByeOnUnload() {
    // Local (SSE/POST): sendBeacon en vez de fetch() - un fetch() en marcha se cancela al
    // desaparecer la pagina, sendBeacon esta diseñado para completarse igualmente durante el
    // unload. sendBeacon no admite cabeceras propias, pero un Blob con type "application/json"
    // hace que el navegador mande el Content-Type correcto igualmente.
    if (this.nativeSSE) {
      const payload = { type: 'bye' };
      if (this._slot !== null) payload.slot = this._slot;
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      // Por el proxy se usa la URL FIRMADA, no callApi: sendBeacon no admite cabeceras, y la firma
      // viaja en la propia URL. Es best-effort en el sentido estricto -- si Home Assistant no
      // aceptara una firma en un POST, lo unico que se pierde es la liberacion inmediata del slot,
      // que el portero recupera solo a los 20s. Nunca hay que hacerlo bloqueante: la pagina ya se
      // esta cerrando.
      const destino = (this._localVia === 'proxy')
        ? this._localSignedUrl
        : ((this._localBase && this._connInfo && this._connInfo.credential)
          ? `${this._localBase}/webrtc/signal/post?token=${encodeURIComponent(this._connInfo.credential)}`
          : null);
      if (destino) {
        try { navigator.sendBeacon(destino, blob); } catch (err) { /* best effort */ }
      }
    }

    // Remoto (WS al relay): sendBeacon no aplica a WebSocket - un send() sincrono sobre una
    // conexion ya abierta es lo mejor disponible aqui (mismo mecanismo que ya usa
    // disconnectedCallback() para este mismo caso).
    if (this.nativeWS && this.nativeWS.readyState === WebSocket.OPEN) {
      try { this.nativeWS.send(JSON.stringify({ type: 'bye' })); } catch (err) { /* best effort */ }
    }
  }

  async startNativeSession() {
    this._t0 = performance.now();
    this._mark('startNativeSession: inicio');
    this._registerUnloadHandler();

    // Bug real encontrado y corregido (2026-07-10, ver COORDINATION.md - reporte del usuario: en
    // una carga en frio del dashboard, la card muestra brevemente "Error" antes de asentarse en
    // el estado correcto). Causa: en una carga en frio, HA puede insertar el elemento en el DOM
    // (disparando connectedCallback() -> startWebRTC() -> aqui) ANTES de que el setter `hass` se
    // haya invocado con una instancia ya hidratada con `.connection` listo - una carrera de
    // arranque real, no un fallo de red ni de configuracion. Antes, esto se trataba como error
    // TERMINAL (badge a "Error" y return inmediato, sin ningun reintento programado - a
    // diferencia de cualquier otro fallo de esta funcion, que si cae en el catch de mas abajo y
    // puede reconectar via _scheduleReconnect()). En la practica, el elemento se reinserta poco
    // despues (HA puede mover/remontar cards durante la hidratacion inicial de una vista), lo que
    // vuelve a disparar connectedCallback() con hass ya listo - de ahi que el usuario viera el
    // error "asentarse solo": no se corregia esta funcion, simplemente un segundo intento con
    // mejor suerte lo tapaba. Ahora se reintenta en silencio (sin tocar el badge, que ya muestra
    // "Conectando..." desde el HTML inicial) durante ~5s antes de rendirse de verdad.
    if (!this._hass || !this._hass.connection) {
      this._hassWaitAttempts = (this._hassWaitAttempts || 0) + 1;
      if (this._hassWaitAttempts <= 20) {
        setTimeout(() => this.startNativeSession(), 250);
        return;
      }
      console.error('[ig-doorbell-card] hass.connection no disponible tras esperar ~5s - no se puede pedir la info de conexion a la integracion ig_doorbell');
      this._setLiveState('error_cam');
      this._hassWaitAttempts = 0;
      // Mismo criterio que el catch de mas abajo (2026-07-10, ver COORDINATION.md): ningun punto
      // de fallo de este fichero debe dejar la card muerta sin ningun camino de recuperacion -
      // si hass.connection sigue sin aparecer, seguimos reintentando con backoff en vez de
      // rendirnos para siempre.
      this._scheduleReconnect('hass.connection no disponible tras esperar ~5s');
      return;
    }
    this._hassWaitAttempts = 0;

    try {
      const info = await this._hass.connection.sendMessagePromise({
        type: 'ig_doorbell/get_connection_info',
        device_id: this.config.device_id,
      });
      this._mark('get_connection_info: respuesta recibida');
      this._connInfo = info;
      this._slot = null;

      this.pc = await this.buildNativePeerConnection();
      this._mark('buildNativePeerConnection: RTCPeerConnection lista');

      // Arranca el vigilante de vida DESDE AQUI - cubre tanto la fase de negociacion (via
      // señalización, ver tryLocalSignaling()/startRelaySignaling() mas abajo) como, una vez
      // conectado, el progreso real de video via getStats() en _checkLifeWatchdog().
      this._startLifeWatchdog();

      this._mark('tryLocalSignaling: empieza el intento local');
      const connectedLocally = await this.tryLocalSignaling();
      this._mark(`tryLocalSignaling: terminado (exito=${connectedLocally})`);
      if (!connectedLocally) {
        this._mark('startRelaySignaling: empieza el intento remoto (fallback)');
        // §1.0: este es el tramo que mas tarda y el que peor se explica solo. Caer al relay
        // significa negociar contra un servidor en Alemania en vez de contra el portero de la
        // habitacion de al lado, y son varios segundos mas de recuadro negro. Decirlo convierte
        // una espera sospechosa en una espera entendida - y de paso avisa de que se esta usando
        // el camino lento, que es informacion util para quien pueda arreglarlo.
        this._flashStatusLine('conn_relay', 6000);
        await this.startRelaySignaling(info);
      }
    } catch (err) {
      // Bug real encontrado y corregido (2026-07-10, ver COORDINATION.md - investigando un
      // "Error" persistente que el lider vio en una card real apuntando a un dispositivo
      // probablemente antiguo/desactivado): este catch es el UNICO punto de fallo de todo el
      // fichero que NO programaba una reconexion - a diferencia de nativeWS.onclose,
      // 'sessions_full', connectionState failed/disconnected, el vigilante de 20s, y un 'bye'
      // recibido, que si llaman todos a _scheduleReconnect(). Si get_connection_info falla (p.ej.
      // el device_id ya no tiene una entrada valida/emparejada en la integracion) o
      // startRelaySignaling() rechaza (el relay no abre la conexion, p.ej. dispositivo no
      // autorizado), la card se quedaba en "Error" para siempre, sin ningun reintento - encaja
      // exactamente con el sintoma de una card mostrando "Error" persistente sin recuperarse
      // sola. Si el dispositivo de verdad ya no existe, esto simplemente reintenta en bucle con
      // backoff (mismo principio ya establecido en el vigilante de vida: mejor seguir
      // intentandolo en silencio que dejar la card muerta) - consistente con el resto del fichero,
      // no un comportamiento nuevo.
      console.error('[ig-doorbell-card] fallo iniciando sesion nativa', err);
      this._setLiveState('error_cam');
      // Este portero ya no esta configurado en ESTE Home Assistant (la integracion lo perdio, o se
      // quito y se volvio a añadir con otra entrada). Reintentar en bucle es correcto, pero sin
      // decir nada el usuario solo ve "Conectando..." para siempre y no tiene forma de saber que
      // lo que falta es volver a emparejar. Ver _reportPairingRejected().
      if (err && err.code === 'not_found') this._reportPairingRejected('get_connection_info: not_found');
      this._scheduleReconnect(`fallo iniciando sesion nativa: ${err && err.message ? err.message : err}`);
    }
  }

  async buildNativePeerConnection() {
    // STUN propio por defecto (API_CONTRACT.md §3.1/B11) - sin credencial, siempre disponible.
    let iceServers = [{ urls: 'stun:46.225.57.138:3478' }];
    try {
      const turn = await this._hass.connection.sendMessagePromise({
        type: 'ig_doorbell/get_turn_credentials',
        device_id: this.config.device_id,
      });
      this._mark('get_turn_credentials: respuesta recibida');
      if (turn && Array.isArray(turn.urls)) {
        iceServers = turn.urls.map((url) => (
          url.startsWith('turn:')
            ? { urls: url, username: turn.username, credential: turn.password }
            : { urls: url }
        ));
      }
    } catch (err) {
      // No bloqueante: sin TURN propio, ICE puede seguir funcionando salvo NAT simetrica en
      // cualquiera de los dos extremos (API_CONTRACT.md §3.1-bis).
      console.warn('[ig-doorbell-card] no se pudieron obtener credenciales TURN, se continua solo con STUN', err);
      // ...pero un 'unauthorized' aqui NO es un problema de TURN: es la nube diciendo que esta
      // credencial de emparejamiento esta revocada. Es una de las tres señales fiables de
      // "vuelve a emparejar" que tiene esta card (las otras dos: el cierre 4401 del relay y un 401
      // del proxy local). Ver _reportPairingRejected().
      if (err && err.code === 'unauthorized') this._reportPairingRejected('get_turn_credentials: unauthorized');
      this._mark('get_turn_credentials: fallo, se sigue solo con STUN');
    }

    const pc = new RTCPeerConnection({ iceServers });

    // Pista de audio muda desde el arranque para no bloquear el video detras del dialogo de
    // permiso de microfono; replaceTrack() al activar el interfono (ver toggleIntercom).
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = audioCtx.createMediaStreamDestination();
    this.dummyAudioTrack = dest.stream.getAudioTracks()[0];

    this.videoTransceiver = pc.addTransceiver('video', { direction: 'recvonly' });
    // Bug real encontrado y corregido (2026-07-11, ver COORDINATION.md Q24/Q24-bis - confirmado
    // con datos reales de una prueba con Playwright, dispositivo de audio falso): esta linea era
    // `pc.addTransceiver(this.dummyAudioTrack, { direction: 'sendrecv' })` y la respuesta SDP
    // generada por esta card decia `a=recvonly` en la linea m=audio, pese a que
    // `audioTransceiver.direction` se leia como 'sendrecv' (con mid=null y currentDirection=null,
    // señal de que ese transceiver NUNCA llego a asociarse a ninguna m-line).
    //
    // Explicacion definitiva, con la spec delante (auditoria 2026-07-12, ver memoria
    // hass_card_audio_investigation): NO es un bug de Chromium ni un matiz sin documentar - es
    // comportamiento especificado. Al aplicar una OFERTA REMOTA (y el doorbell es SIEMPRE el
    // offerer, ICE-Lite, nunca procesa ofertas entrantes), RFC 9429 (JSEP) §5.10 y los pasos de
    // setRemoteDescription() de webrtc-pc solo permiten asociar cada m-line entrante con un
    // transceiver local existente si ese transceiver FUE CREADO POR addTrack() - los creados con
    // addTransceiver() quedan excluidos de ese matching a proposito (solo se asocian cuando este
    // lado genera la oferta, cosa que aqui no pasa nunca). Consecuencia exacta de la version
    // antigua: el transceiver explicito quedaba huerfano para siempre, setRemoteDescription()
    // creaba OTRO transceiver implicito para la m-line de audio con direction por defecto
    // 'recvonly', y la respuesta salia a=recvonly - el navegador no enviaba ni un paquete RTP de
    // audio. El video "funcionaba" con ambas variantes solo por coincidencia: el default del
    // transceiver implicito ('recvonly') es justo lo que el video quiere. El dashboard web
    // (`main/webtask.c`, en produccion) usa `pc.addTrack(track)` - la via correcta por spec para
    // un peer que siempre responde ofertas, no solo "la que funciono".
    const audioSender = pc.addTrack(this.dummyAudioTrack);
    this.audioTransceiver = pc.getTransceivers().find((t) => t.sender === audioSender) || null;
    console.log(
      '[ig-doorbell-card DIAG audio] audioTransceiver creado via addTrack(): ' +
      `direction=${this.audioTransceiver ? this.audioTransceiver.direction : '(no encontrado)'} ` +
      `sender.track=${audioSender.track ? audioSender.track.id : 'null'}`
    );

    pc.ontrack = (event) => this.setupRemoteStream(event.streams[0]);

    // El dispositivo es ICE-Lite: solo emite su candidato una vez, en el SDP de la oferta -
    // pero SI espera trickle ICE de este lado (API_CONTRACT.md §3.3).
    pc.onicecandidate = (e) => {
      if (e.candidate) this.sendNativeSignal({ type: 'candidate', candidate: e.candidate.candidate });
    };

    pc.onconnectionstatechange = () => {
      this._mark(`RTCPeerConnection.connectionState -> ${pc.connectionState}`);
      // Atajo AGRESIVO (2026-07-10, decision del usuario, ver COORDINATION.md Q19 - mismo
      // criterio que android_app en su propio watchdog): tanto 'failed' COMO 'disconnected'
      // disparan reconexion inmediata, sin esperar el resto del cronometro de 20s del vigilante
      // de vida - a sabiendas de que 'disconnected' puede ser transitorio (una recuperacion
      // normal de la propia ICE podria interrumpirse de vez en cuando). Decision consciente para
      // validar en real contra cobertura 4G/5G mala, no un descuido. Esto ademas cierra de raiz
      // el caso que preocupaba antes (señalización local "exitosa" pero conexion real fallida
      // despues sin plan B) - ahora SI hay plan B: reconectar, que vuelve a intentar
      // local-primero-luego-remoto desde cero.
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this._scheduleReconnect(`RTCPeerConnection.connectionState=${pc.connectionState}`);
      }
    };

    return pc;
  }

  // Intenta primero el camino local: HTTPS real del propio doorbell
  // (`https://<device_id>.doorbell.islautopia.com:8443/webrtc/signal`, API_CONTRACT.md §1.4).
  // Deliberadamente NO se prueba nunca un candidato "IP cruda + HTTP" aqui: si el dashboard de
  // HA se sirve por HTTPS, el navegador bloquearia ese fetch como "mixed content"; si se sirve
  // por HTTP, el microfono ya esta bloqueado por el navegador para toda la pagina
  // independientemente de a que hable la card (limitacion del "contexto seguro" del propio
  // origen de HA, no de esta card - ver ARCHITECTURE.md, nota sobre mixed content). Usar
  // siempre el hostname real (nunca una IP) es ademas obligatorio para que el certificado
  // Let's Encrypt del doorbell valide correctamente.
  //
  // Auth (anadido 2026-07-09, ver COORDINATION.md): /webrtc/signal y /webrtc/signal/post ya NO
  // aceptan conexiones sin credencial - hace falta "?token=<credencial de pair_app>" en la URL
  // (EventSource no admite cabeceras propias, de ahi el query param en vez de Authorization).
  // Es la MISMA credencial que ya se pedia para el WS remoto (this._connInfo.credential) - un
  // token invalido/ausente da 401 en vez de la oferta.
  // ==============================================================================
  // EL CAMINO LOCAL, EN DOS VARIANTES (2026-08-03)
  //
  // Se prefiere SIEMPRE el proxy de señalizacion de la propia integracion de Home Assistant
  // (`ig_doorbell/get_local_signal_url` -> `/api/ig_doorbell/signal/<device_id>`),
  // y se cae a la variante de siempre -hablar directamente al hostname publico del portero- solo
  // si la integracion instalada es anterior y no ofrece ese comando.
  //
  // POR QUE EL PROXY ES MEJOR, y no es una preferencia estetica: el hostname publico del portero
  // resuelve a una IP privada de la LAN. Esa combinacion tiene exactamente la forma de un ataque
  // de DNS rebinding, y iCloud Private Relay la bloquea a proposito. Private Relay viene activado
  // de fabrica en practicamente cualquier iPhone, y la app companion es donde mas gente abre un
  // dashboard desde el movil: el camino local estaba fallando justo para el grupo mas grande de
  // usuarios, que acababa saliendo a Alemania por el relay para ver una camara de su propia casa.
  // Home Assistant, en cambio, ya es un origen que ese navegador ha resuelto y en el que confia.
  //
  // Lo que NO pasa por el proxy: el MEDIO. Solo unos pocos kilobytes de SDP y candidatos ICE por
  // sesion. El video y el audio siguen yendo punto a punto por UDP contra la direccion LAN del
  // portero, que es lo que Private Relay no toca. O sea que esto RECUPERA el camino directo
  // rapido, no lo sustituye por uno lento.
  //
  // Beneficio adicional que conviene no perder de vista: por este camino la credencial de
  // pair_app NO llega nunca al JavaScript del navegador - se queda en el lado servidor de la
  // integracion, que es quien la adjunta al hablar con el portero.
  // ==============================================================================
  async tryLocalSignaling() {
    if (typeof EventSource === 'undefined') return false;

    const proxyUrl = await this._askLocalSignalUrl();
    if (proxyUrl) {
      this._localVia = 'proxy';
      this._localSignedUrl = proxyUrl;
      const ok = await this._openLocalSse(proxyUrl, 'proxy');
      if (ok) return true;
      // La SSE no distingue un 401 de un 502 (el navegador no expone el codigo de estado a
      // EventSource), y esa diferencia es justo la que decide entre "vuelve a emparejar" y
      // "esto no llega al portero ahora mismo". Se clasifica con una peticion aparte.
      await this._classifyProxyFailure();
      return false;
    }

    this._localVia = 'directo';
    if (!this._connInfo || !this._connInfo.credential) return false;
    const hostname = `${this.config.device_id}.doorbell.islautopia.com`;
    this._localBase = `https://${hostname}:8443`;
    const token = encodeURIComponent(this._connInfo.credential);
    return this._openLocalSse(`${this._localBase}/webrtc/signal?token=${token}`, 'directo');
  }

  // `null` = esta integracion no ofrece el proxy (version anterior) o no sabe de este portero.
  // No es un error: hay un camino de respaldo, y anunciarlo como fallo confundiria al depurar.
  async _askLocalSignalUrl() {
    if (!this._hass || !this._hass.connection) return null;
    try {
      const res = await this._hass.connection.sendMessagePromise({
        type: 'ig_doorbell/get_local_signal_url',
        device_id: this.config.device_id,
      });
      if (res && res.signal_url) {
        this._mark('get_local_signal_url: la integracion ofrece proxy de senalizacion');
        return res.signal_url;
      }
      return null;
    } catch (err) {
      this._mark(`get_local_signal_url: no disponible (${err && err.code ? err.code : 'error'}) - se usa el hostname publico del portero`);
      return null;
    }
  }

  // Una sola peticion, sin efectos: un `bye` de señalizacion sin slot lo descarta el portero en
  // silencio, asi que lo unico que se saca de aqui es el CODIGO de estado. El proxy lo pasa tal
  // cual desde el portero (401) o pone el suyo (502 = Home Assistant no alcanza al portero).
  async _classifyProxyFailure() {
    if (!this._hass || typeof this._hass.callApi !== 'function') return;
    try {
      await this._hass.callApi('POST', `ig_doorbell/signal/${this.config.device_id}`, { type: 'bye' });
    } catch (err) {
      const status = err && (err.status_code || err.status);
      if (status === 401) {
        this._reportPairingRejected('proxy local de Home Assistant: 401');
      } else if (status === 502) {
        this._mark('proxy local: 502 - Home Assistant no alcanza al portero (apagado, u otra VLAN sin ruta). Al relay.');
      } else {
        this._mark(`proxy local: fallo sin clasificar (status=${status})`);
      }
    }
  }

  _openLocalSse(sseUrl, via) {
    return new Promise((resolve) => {
      let settled = false;
      let probeTimer = null;
      const probeCtl = (typeof AbortController !== 'undefined') ? new AbortController() : null;

      const stopProbe = () => {
        if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
        if (probeCtl) { try { probeCtl.abort(); } catch (err) { /* ya terminada */ } }
      };

      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        stopProbe();
        resolve(ok);
      };

      // Abandonar el camino local SIN dejarse el slot cogido (2026-07-29). El portero asigna slot
      // al aceptar la SSE, y solo da por abandonada una sesion sin `bye` a los 20s. Con
      // MAX_WEBRTC_SESSIONS=4, unos cuantos reintentos que se van por las bravas dejan al usuario
      // sin slots libres -- y eso se manifiesta como "fallos del relay", que es donde se buscaria
      // el problema y no donde esta. Si nunca llegamos a tener slot no hay nada que soltar, y el
      // `bye` se ahorra.
      const abandonLocal = () => {
        if (!this.nativeSSE) return;
        if (this._slot !== null) {
          try { this.sendNativeSignal({ type: 'bye' }); } catch (err) { /* best effort */ }
        }
        this.nativeSSE.close();
        this.nativeSSE = null;
      };

      const timeout = setTimeout(() => {
        this._mark(`tryLocalSignaling(${via}): timeout de 3000ms agotado sin oferta`);
        abandonLocal();
        finish(false);
      }, 3000);

      this._mark(`tryLocalSignaling(${via}): abriendo EventSource`);
      try {
        this.nativeSSE = new EventSource(sseUrl);
      } catch (err) {
        clearTimeout(timeout);
        console.warn('[ig-doorbell-card] no se pudo abrir EventSource local, cayendo al relay remoto:', err);
        this._mark('tryLocalSignaling: EventSource lanzo excepcion al crearse');
        resolve(false);
        return;
      }

      // ==========================================================================================
      // SONDA DE ALCANCE, en paralelo con la SSE (2026-07-29). Resuelve un problema real medido:
      // cuando el camino local no cuaja, se pagaban los 3000ms COMPLETOS del timeout de arriba
      // antes de que el camino remoto empezara siquiera, y el reloj de ICE/DTLS arranca despues de
      // eso. Con un iPhone en la MISMA red que el portero, que es el mejor caso posible, la
      // conexion tardaba de mas por esta espera a ciegas.
      //
      // La sonda no acorta el timeout: lo sustituye por una respuesta. Pregunta exactamente lo que
      // el camino local necesita -- DNS + TLS + ruta hasta el portero -- contra la unica ruta que
      // se puede tocar sin coste: `/api/device_id` existe en el 8443, no exige sesion y NO reserva
      // ningun slot de sesion WebRTC. Si algo bloquea el camino local, la sonda falla igual que
      // fallaria la SSE, pero en 1200ms en vez de 3000.
      //
      // `mode:'no-cors'` es OBLIGATORIO: esa ruta no lleva cabeceras CORS (solo las llevan
      // /webrtc/signal y /webrtc/signal/post). No hace falta leer la respuesta -- solo saber si la
      // peticion llega. Una respuesta opaca ya significa "alcanzable"; un rechazo, "no".
      // `cache:'no-store'` para que una respuesta cacheada no de un veredicto rancio.
      //
      // Las TRES reglas. La tercera se aprendio midiendo contra el portero real (2026-08-03) y
      // corrige un fallo que estaba tirando el camino local en la mejor situacion posible:
      //  1. La sonda falla de verdad (error de red/DNS) -> se abandona el local YA, sin esperar el
      //     resto del timeout.
      //  2. La sonda responde -> el portero es alcanzable, asi que se SIGUE esperando la oferta
      //     hasta los 3000ms de siempre. Que responda la sonda no garantiza que la SSE entregue
      //     rapido, y cortar aqui cambiaria un fallo lento por un fallo prematuro.
      //  3. La sonda EXPIRA -> no se abandona nada. Una expiracion no es un veredicto: dice que el
      //     portero es lento, no que no este. Medido con curl contra el aparato real en la misma
      //     red: el handshake TLS del ESP32 solo tarda entre 0,40s y 0,90s, y la peticion completa
      //     entre 0,46s y 1,06s. Con el presupuesto anterior de 1200ms, una conexion perfecta en la
      //     propia casa se declaraba "inalcanzable" por unas decenas de milisegundos y se salia por
      //     el relay -- a Alemania, para ver una camara del pasillo. Visto en dos ejecuciones
      //     seguidas: una dio 1094ms (paso por los pelos) y la siguiente 1202ms (fallo). El
      //     presupuesto sube ademas a 2000ms, pero lo que de verdad arregla esto es que expirar ya
      //     no mata el camino: se deja decidir al timeout de 3000ms, que es quien tiene el dato
      //     bueno -- si llego la oferta o no.
      //
      // Sospechoso principal de este caso concreto, y por eso la sonda es del mismo tipo que la
      // peticion real: iCloud Private Relay bloquea a proposito un hostname publico que resuelve a
      // una IP privada, que es exactamente lo que hace el hostname del portero dentro de casa.
      //
      // Descartado a proposito: recordar que camino gano la ultima vez. Se queda rancio en cuanto
      // el movil cambia de red -- que es lo que hace un movil todo el rato -- y para volver al
      // local habria que re-sondear abriendo la SSE, que eso SI gasta un slot. La sonda no guarda
      // estado y por eso no puede quedarse desactualizada.
      // ==========================================================================================
      //
      // Solo aplica al camino DIRECTO. Por el proxy no hay nada que sondear: el origen es el
      // propio Home Assistant, que el navegador ya resolvio, y quien no alcance al portero es
      // Home Assistant - cosa que contesta el mismo con un 502 inmediato en vez de con silencio.
      if (via === 'directo' && typeof fetch === 'function' && probeCtl) {
        const probeT0 = performance.now();
        let probeExpirada = false;
        probeTimer = setTimeout(() => {
          probeExpirada = true;
          try { probeCtl.abort(); } catch (err) { /* noop */ }
        }, 2000);
        fetch(`${this._localBase}/api/device_id`, { mode: 'no-cors', cache: 'no-store', signal: probeCtl.signal })
          .then(() => {
            if (settled) return;
            if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
            this._mark(`sonda de alcance: el portero SI responde (${Math.round(performance.now() - probeT0)}ms) - se sigue esperando la oferta`);
          })
          .catch(() => {
            if (settled) return; // abortada por nosotros al terminar: no es un veredicto
            if (probeExpirada) {
              // Regla 3: lento no es ausente. Se deja seguir a la SSE con su propio plazo.
              this._mark(`sonda de alcance: expiro a los ${Math.round(performance.now() - probeT0)}ms sin veredicto - NO se abandona el local, decide el timeout de 3000ms`);
              return;
            }
            this._mark(`sonda de alcance: el portero NO es alcanzable (${Math.round(performance.now() - probeT0)}ms) - al relay sin esperar el resto de los 3000ms`);
            abandonLocal();
            finish(false);
          });
      } else if (via === 'directo') {
        this._mark('sonda de alcance: no disponible en este navegador (sin fetch/AbortController) - se espera el timeout completo');
      }

      // No hay forma fiable de distinguir desde JS "bloqueado por CORS" de "red inalcanzable"
      // u "otro fallo de red" - EventSource.onerror (igual que fetch()) no expone el motivo real
      // por diseño del navegador, ni siquiera cuando la causa es CORS.
      //
      // ACTUALIZADO 2026-07-26: el texto anterior de este aviso decia que el doorbell "no manda
      // Access-Control-Allow-Origin en :8443" y señalaba a CORS como causa mas probable. Eso
      // dejo de ser cierto el 2026-07-10 - el firmware manda `Access-Control-Allow-Origin: *` en
      // toda respuesta de /webrtc/signal y /webrtc/signal/post (incluidos los 401) y contesta al
      // preflight OPTIONS con Allow-Methods GET/POST/OPTIONS + Allow-Headers Content-Type (que
      // es justo lo que necesita el POST de señalización, que va con Content-Type:
      // application/json y por tanto NO es una peticion "simple"). Verificado leyendo el
      // firmware real, no asumido. Mantener aqui el diagnostico viejo mandaria a quien depure
      // esto en el futuro directo a una pista falsa - hoy las causas realistas son otras.
      this.nativeSSE.onerror = () => {
        abandonLocal();
        if (via === 'proxy') {
          console.warn(
            '[ig-doorbell-card] la senalizacion local via el proxy de Home Assistant fallo - cayendo al relay remoto. ' +
            'El navegador NO expone el codigo de estado a EventSource, asi que se clasifica aparte (ver _classifyProxyFailure): ' +
            'un 401 significa credencial de emparejamiento rechazada, un 502 que Home Assistant no alcanza al portero.'
          );
          finish(false);
          return;
        }
        console.warn(
          '[ig-doorbell-card] señalización local (%s) fallo o no respondió a tiempo - cayendo al relay remoto. ' +
          'El navegador NO expone a este script el motivo exacto (revisa la pestaña Network/Console de las DevTools). ' +
          'Causas realistas, en orden: (1) el doorbell no es alcanzable desde la red de HA (VLAN/subred distinta, o ' +
          'HA visto desde fuera de casa via Nabu Casa) - es el caso normal y el fallback remoto lo cubre; ' +
          '(2) el hostname <device_id>.doorbell.islautopia.com no resuelve o resuelve a una IP que este resolutor ' +
          'bloquea (iCloud Private Relay bloquea hostnames publicos que apuntan a IPs privadas); ' +
          '(3) token de pair_app invalido/revocado (401); (4) certificado del doorbell caducado. ' +
          'CORS ya NO es sospechoso desde 2026-07-10: el firmware manda Access-Control-Allow-Origin en estas rutas.',
          `${this._localBase}/webrtc/signal`
        );
        finish(false);
      };

      this.nativeSSE.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (err) { return; }
        // Cualquier mensaje (incluido el heartbeat) es una señal de vida real del canal de
        // señalización - vigilante de vida, ver COORDINATION.md Q19.
        this._recordLifeSignal();
        if (msg.type === 'heartbeat') return;
        if (msg.type === 'offer') {
          this._mark('tryLocalSignaling: oferta recibida por SSE');
          finish(true);
        }
        this.handleNativeSignal(msg);
      };
    });
  }

  async startRelaySignaling(info) {
    return new Promise((resolve, reject) => {
      const url = `${info.relay_ws_url}?token=${encodeURIComponent(info.credential)}`;
      let opened = false;
      this._mark(`startRelaySignaling: abriendo WS contra ${info.relay_ws_url}`);
      this.nativeWS = new WebSocket(url);

      this.nativeWS.onopen = () => {
        opened = true;
        this._mark('startRelaySignaling: WS abierto, enviando request_offer');
        this.sendNativeSignal({ type: 'request_offer' });
        resolve();
      };
      this.nativeWS.onerror = (err) => {
        if (!opened) reject(err);
      };
      this.nativeWS.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (err) { return; }
        // Cualquier mensaje del relay es una señal de vida real del canal de señalización -
        // vigilante de vida, ver COORDINATION.md Q19.
        this._recordLifeSignal();
        this.handleNativeSignal(msg);
      };
      this.nativeWS.onclose = (ev) => {
        // 4401 es el codigo con el que el relay cierra una conexion de cliente cuya credencial de
        // pair_app no es valida o esta revocada, ANTES de unirse a ninguna sesion (§3.2). Es la
        // señal mas precisa que existe de "vuelve a emparejar": el resto de cierres son de red.
        if (ev && ev.code === 4401) this._reportPairingRejected('relay: cierre 4401 (credencial invalida o revocada)');
        if (this.badge && this.videoEl && !this.videoEl.srcObject) {
          this._setLiveState('error_cam');
        }
      };
    });
  }

  sendNativeSignal(msg) {
    const payload = Object.assign({}, msg);
    if (this.nativeSSE) {
      // Local (SSE/POST): el "slot" recibido en la oferta es obligatorio en cada mensaje
      // saliente (API_CONTRACT.md §1.4/§3.3). "?token=" obligatorio desde 2026-07-09 (misma
      // credencial que abrio el EventSource en tryLocalSignaling) - sin el, 401.
      if (this._slot !== null) payload.slot = this._slot;
      else if (msg.type !== 'bye') {
        // El firmware DESCARTA en silencio (solo un log en el puerto serie del portero, invisible
        // desde aqui) cualquier POST de señalización local sin un "slot" valido - verificado en
        // el codigo real, no asumido. Sin este aviso, un mensaje perdido asi se manifestaria como
        // "el turno de palabra/la calidad no funcionan" sin ninguna pista en el navegador.
        console.warn(`[ig-doorbell-card] mensaje local "${msg.type}" enviado sin slot asignado todavia - el dispositivo lo descartara`);
      }
      if (this._localVia === 'proxy') {
        // Por el proxy la peticion va autenticada como cualquier llamada del frontend a su propio
        // Home Assistant (callApi pone la cabecera Authorization). La URL FIRMADA existe solo para
        // el EventSource, que no puede llevar cabeceras propias - aqui no hace falta.
        this._hass.callApi('POST', `ig_doorbell/signal/${this.config.device_id}`, payload)
          .catch((err) => {
            const status = err && (err.status_code || err.status);
            if (status === 401) this._reportPairingRejected('proxy local de Home Assistant: 401 al enviar senalizacion');
            console.warn('[ig-doorbell-card] fallo enviando senal local via el proxy de Home Assistant', err);
          });
        return;
      }
      const token = this._connInfo ? encodeURIComponent(this._connInfo.credential) : '';
      fetch(`${this._localBase}/webrtc/signal/post?token=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch((err) => console.warn('[ig-doorbell-card] fallo enviando senal local', err));
    } else if (this.nativeWS && this.nativeWS.readyState === WebSocket.OPEN) {
      // Remoto (WS relay): sin "slot", el relay ya enruta 1:1 por device_id.
      this.nativeWS.send(JSON.stringify(payload));
    }
  }

  async handleNativeSignal(msg) {
    // El slot propio se aprende SOLO de 'offer' y 'session_info' (2026-07-26). Todo mensaje del
    // dispositivo lleva `slot`, pero aprenderlo de cualquiera de ellos seria peligroso en el
    // camino REMOTO: el relay hace fan-out a todos los clientes del mismo device_id, asi que un
    // mensaje ajeno nos sobrescribiria nuestro propio slot y a partir de ahi interpretariamos mal
    // `talker` (creernos dueños del turno de otro, o al reves). Estos dos mensajes SI son
    // inequivocamente "para mi": la oferta abre nuestra sesion y session_info es el
    // resincronizador por destinatario.
    if ((msg.type === 'offer' || msg.type === 'session_info') && typeof msg.slot === 'number') {
      this._slot = msg.slot;
    }

    switch (msg.type) {
      case 'offer':
        this._mark('handleNativeSignal(offer): procesando oferta SDP');
        await this.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.sendNativeSignal({ type: 'answer', sdp: answer.sdp });
        this._mark('handleNativeSignal(offer): respuesta SDP enviada (ICE/DTLS empieza ahora)');
        // Sonda de calidad en cuanto hay slot asignado (no hace falta esperar a que ICE/DTLS
        // termine: el dispositivo asigna el slot al procesar la conexion/request_offer, y el
        // canal de señalización ya esta vivo - es el mismo criterio que el contrato documenta
        // para el mensaje 'open'). Ver _probeQualitySupport().
        this._probeQualitySupport();
        // Diagnostico real (2026-07-11, ver COORDINATION.md - investigando backchannel de audio
        // silencioso reportado por el usuario, confirmado exclusivo de esta card: dashboard web y
        // apps SI funcionan bidireccional). Sin acceso a navegador real en esta sesion, esto deja
        // constancia en consola de EXACTAMENTE que direccion quedo negociada para el audio nada
        // mas aplicar la respuesta - antes de que el usuario toque el boton de mic. Si esto ya
        // sale distinto de 'sendrecv' aqui, el problema esta en la negociacion SDP, no en
        // toggleIntercom()/replaceTrack() (mas abajo, con su propio log).
        if (this.audioTransceiver) {
          console.log(
            '[ig-doorbell-card DIAG audio] tras setLocalDescription(answer): ' +
            `audioTransceiver.direction=${this.audioTransceiver.direction} ` +
            `currentDirection=${this.audioTransceiver.currentDirection} ` +
            `mid=${this.audioTransceiver.mid} ` +
            `sender.track=${this.audioTransceiver.sender && this.audioTransceiver.sender.track ? this.audioTransceiver.sender.track.id : 'null'}`
          );
          const audioLine = (answer.sdp.split('\r\n').find((l) => l.startsWith('m=audio')) || '') + ' | ' +
            (answer.sdp.split('\r\n').find((l) => l.startsWith('a=sendrecv') || l.startsWith('a=sendonly') || l.startsWith('a=recvonly') || l.startsWith('a=inactive')) || '(sin atributo de direccion global - revisar por m-section)');
          console.log(`[ig-doorbell-card DIAG audio] SDP de la respuesta (linea m=audio + primer atributo de direccion encontrado): ${audioLine}`);
        }
        break;
      case 'candidate':
        if (msg.candidate && this.pc.remoteDescription) {
          try {
            await this.pc.addIceCandidate({ candidate: msg.candidate, sdpMid: '0', sdpMLineIndex: 0 });
          } catch (err) { /* candidato descartable, no bloqueante */ }
        }
        break;
      case 'open_result':
        this.handleNativeOpenResult(msg);
        break;
      // ---- Multicliente / calidad (API_CONTRACT.md §1.4-ter, 2026-07-26) --------------------
      case 'talk_granted':
        this._handleTalkGranted(msg);
        break;
      case 'talk_denied':
        this._handleTalkDenied(msg);
        break;
      case 'talk_state':
        if (typeof msg.talker === 'number') this._talkerSlot = msg.talker;
        this._reconcileTalkTurn();
        break;
      case 'session_info':
        this._handleSessionInfo(msg);
        break;
      case 'quality_state':
        this._handleQualityState(msg);
        break;
      case 'error':
        console.warn('[ig-doorbell-card] error de senalizacion nativa:', msg.reason);
        if (msg.reason === 'sessions_full' && this.badge) this._setLiveState('error_cam');
        break;
      case 'bye':
        // El dispositivo cerro la sesion (p.ej. desplazado por otra) - reconecta
        // automaticamente en vez de dejar la card muerta hasta que el usuario recargue a mano
        // (2026-07-10, ver COORDINATION.md Q19 - mismo mecanismo que el resto del vigilante).
        this._scheduleReconnect('bye recibido del dispositivo');
        break;
      default:
        break;
    }
  }

  triggerNativeOpen() {
    if (!this.unlockButton) return;
    this.sendNativeSignal({ type: 'open' });
    this._paintDoorOpening();
    // 6s: el `open` viaja por el mismo canal de senalizacion que la oferta, que en el peor caso
    // real medido (camino remoto, por el relay) tarda ~2,5s en ida. El doble de largo, para no
    // acusar de fallo a una red simplemente lenta.
    if (this._doorWaitTimer) clearTimeout(this._doorWaitTimer);
    this._doorWaitTimer = setTimeout(() => this._doorOpenNoAnswer(), 6000);
  }

  // ==============================================================================
  // NADA OCURRE EN SILENCIO (API_CONTRACT.md §1.0) - abrir la puerta
  //
  // Esto corrige UNA MENTIRA, no solo un hueco: al pulsar, la card pintaba el boton en verde y la
  // etiqueta en "Abierta" ANTES de que el portero hubiera contestado nada. Si el `open_result` no
  // llegaba -- red mala, sesion caida, rele que no responde -- el usuario se quedaba mirando un
  // boton que decia "Abierta" con la puerta cerrada. En un videoportero eso no es un detalle de
  // interfaz: es alguien que se va de la puerta creyendo que ha abierto.
  //
  // Ahora hay tres estados y ninguno se adelanta al siguiente: ABRIENDO (se ha mandado), ABIERTA
  // (el portero lo ha confirmado) y SIN RESPUESTA (se agoto el plazo). Un tiempo agotado es un
  // tiempo agotado, nunca un "abierta" (§1.8).
  // ==============================================================================
  _paintDoorOpening() {
    if (!this.unlockButton) return;
    this.unlockButton.classList.add('opening');
    this.unlockButton.classList.remove('active-unlock');
    if (this.unlockIcon) this.unlockIcon.setAttribute('icon', 'mdi:loading');
    if (this.unlockLabel) {
      this.unlockLabel.textContent = getLocalText(this._hass, 'lbl_door_opening');
      this.unlockLabel.classList.remove('on-green');
      this.unlockLabel.classList.add('on-amber');
    }
    // 8s de aviso, mas que el plazo de 6s: el mensaje no puede desaparecer ANTES de que se sepa
    // como acabo la cosa, o el usuario se queda sin ninguna respuesta a lo que acaba de pulsar.
    this._flashStatusLine('door_opening', 8000);
  }

  _clearDoorWait() {
    if (this._doorWaitTimer) { clearTimeout(this._doorWaitTimer); this._doorWaitTimer = null; }
    if (this.unlockButton) this.unlockButton.classList.remove('opening');
    if (this.unlockLabel) this.unlockLabel.classList.remove('on-amber');
  }

  _doorOpenNoAnswer() {
    this._clearDoorWait();
    if (this.unlockIcon) this.unlockIcon.setAttribute('icon', 'mdi:key');
    this._setDoorLabel(false);
    console.warn('[ig-doorbell-card] no llego ningun open_result en 6s - NO se afirma que la puerta se haya abierto');
    this._flashStatusLine('door_no_answer', 6000);
  }

  handleNativeOpenResult(msg) {
    this._clearDoorWait();
    if (!this.unlockButton) return;
    const duration = parseInt(this.config.unlock_duration) || 3;
    if (msg.status === 'opened') {
      // Si el portero abre, es que SI tiene cerradura: se olvida lo aprendido a base de fallar
      // (solo aplica contra un firmware anterior, ver _applyDoorAvailability).
      if (this._noLockLegacy) { this._noLockLegacy = false; this._applyDoorAvailability(); }
      // AHORA si: confirmado por el portero, no antes.
      this.unlockButton.classList.add('active-unlock');
      this.unlockIcon.setAttribute('icon', 'mdi:door-open');
      this._setDoorLabel(true);
      this._startDoorCountdown(duration);
      setTimeout(() => {
        this.unlockButton.classList.remove('active-unlock');
        this.unlockIcon.setAttribute('icon', 'mdi:key');
        this._setDoorLabel(false);
      }, duration * 1000);
    } else {
      this.unlockButton.classList.remove('active-unlock');
      this.unlockIcon.setAttribute('icon', 'mdi:key');
      this._setDoorLabel(false);
      console.warn('[ig-doorbell-card] no se pudo abrir la puerta:', msg.error);
      if (msg.error === 'no_lock_configured') {
        this._flashStatusLine('no_lock', 3000);
        // Red de seguridad para un firmware anterior a que `door_m` viajara en session_info: si
        // ese dato ya ha llegado, esto no cambia nada (manda el dato) y el boton no deberia
        // haberse ofrecido siquiera. El aviso de esta vez SI se enseña: el usuario acaba de
        // pulsar y merece saber por que no pasa nada.
        this._noLockLegacy = true;
        this._applyDoorAvailability();
      }
    }
  }

  // Punto de entrada del boton de micro. Desde 2026-07-26 NO abre el micro directamente: pide
  // antes el turno de palabra (§1.4-ter) y solo _startIntercom() al recibir talk_granted - o
  // tras comprobar que este portero no arbitra turnos (firmware anterior). Ver _requestTalkTurn().
  async toggleTalk() {
    if (this._talkPending) return; // ya hay una peticion en vuelo, no encolar otra
    if (this.talkActive || this._listenOnly) {
      await this._stopTalk();
      return;
    }
    this._requestTalkTurn();
  }

  async _startTalk() {
    this.talkActive = true;
    this._listenOnly = false;
    {
      try {
        // Hablar implica oir, obviamente. Se recuerda como estaba el sonido para devolverlo a su
        // sitio al cerrar el micro: si solo estabas mirando en silencio, seguiras mirando en
        // silencio (§1.10); si ya estabas escuchando, seguiras escuchando.
        this._audioOnBeforeMic = this._audioOn;
        this._setAudioOn(true, 'micro');
        console.log('[ig-doorbell-card DIAG audio] toggleIntercom: pidiendo getUserMedia({audio:true})...');
        this.localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const realAudioTrack = this.localAudioStream.getAudioTracks()[0];
        console.log(
          '[ig-doorbell-card DIAG audio] getUserMedia OK: ' +
          `track.id=${realAudioTrack.id} label="${realAudioTrack.label}" ` +
          `readyState=${realAudioTrack.readyState} enabled=${realAudioTrack.enabled} muted=${realAudioTrack.muted}`
        );
        if (this.audioTransceiver && this.audioTransceiver.sender) {
          const senderBefore = this.audioTransceiver.sender.track;
          console.log(`[ig-doorbell-card DIAG audio] replaceTrack: sender.track ANTES=${senderBefore ? senderBefore.id : 'null'} (deberia ser la pista muda ${this.dummyAudioTrack ? this.dummyAudioTrack.id : '?'})`);
          await this.audioTransceiver.sender.replaceTrack(realAudioTrack);
          const senderAfter = this.audioTransceiver.sender.track;
          console.log(
            `[ig-doorbell-card DIAG audio] replaceTrack OK: sender.track DESPUES=${senderAfter ? senderAfter.id : 'null'} ` +
            `(coincide con el track real=${senderAfter === realAudioTrack}) ` +
            `direction=${this.audioTransceiver.direction} currentDirection=${this.audioTransceiver.currentDirection}`
          );
          // Gotcha real y conocido de WebRTC, barato de comprobar: si encodings[0].active es
          // false, el navegador NO envia RTP para ese encoding pase lo que pase con el track/
          // direction - aunque nada de lo anterior haya fallado. No deberia pasar aqui (nunca se
          // llama a setParameters() en todo este fichero), pero confirmarlo con datos reales en
          // vez de asumirlo.
          try {
            const params = this.audioTransceiver.sender.getParameters();
            console.log(`[ig-doorbell-card DIAG audio] sender.getParameters().encodings=${JSON.stringify(params.encodings)}`);
          } catch (paramsErr) {
            console.warn('[ig-doorbell-card DIAG audio] sender.getParameters() fallo', paramsErr);
          }
        } else {
          console.warn('[ig-doorbell-card DIAG audio] replaceTrack OMITIDO: audioTransceiver/sender no existe en este momento - el mic NUNCA se activo de verdad pese a que la UI va a decir que si');
        }
        this._startAudioSendDiagnostics();

        this._setLiveState('open');
        if (this.audioPill) this.audioPill.style.display = 'flex';
        this._paintMicState();
        this._updateMotionPill(); // regla: nunca visible con el mic activo
      } catch (err) {
        console.warn('[ig-doorbell-card] no se pudo activar el microfono', err);
        this.talkActive = false;
        this.videoEl.muted = true;
        // Soltar el turno que el dispositivo acababa de concedernos: quedarnos con el canal de
        // voz reservado sin poder usarlo (permiso de microfono denegado, sin dispositivo de
        // captura, pagina servida por HTTP plano...) dejaria a los DEMAS clientes sin poder
        // hablar hasta que el portero lo libere solo a los 5s. Es justo el fallo que el turno de
        // palabra existe para evitar.
        if (this._talkHeld) {
          this.sendNativeSignal({ type: 'talk_release' });
          this._talkHeld = false;
        }
        this._paintMicState();
      }
    }
  }

  // Cierre real del microfono (hardware + sender), sin tocar el estado logico del turno - lo
  // comparten _stopIntercom() (el usuario lo apaga) y _enterListenOnly() (el dispositivo nos
  // quita el turno). Extraido para que ninguno de los dos caminos pueda olvidarse un paso.
  _closeMicHardware() {
    this._stopAudioSendDiagnostics();
    if (this.localAudioStream) {
      this.localAudioStream.getTracks().forEach((track) => track.stop());
      this.localAudioStream = null;
    }
    if (this.audioTransceiver && this.audioTransceiver.sender && this.dummyAudioTrack) {
      // Vuelve a la pista MUDA en vez de a null: el transceiver debe seguir con una pista viva
      // (mismo patron pista-muda+replaceTrack que evita renegociar SDP, ver
      // buildNativePeerConnection).
      try { this.audioTransceiver.sender.replaceTrack(this.dummyAudioTrack); } catch (err) { /* best effort */ }
    }
  }

  async _stopTalk() {
    // Suelta el turno explicitamente (§1.4-ter): sin esto el portero lo mantendria reservado
    // hasta agotar sus 5s de silencio, y otro cliente que quisiera hablar en ese hueco recibiria
    // un talk_denied injusto. Se manda incluso en modo "solo escucha" (turno denegado) por si el
    // dispositivo nos lo hubiera concedido justo despues - es idempotente.
    this.sendNativeSignal({ type: 'talk_release' });
    this._talkHeld = false;
    this._listenOnly = false;
    this.talkActive = false;
    this._setAudioOn(this._audioOnBeforeMic, 'micro-cerrado');
    this._closeMicHardware();
    this._setLiveState('live');
    if (this.audioPill) this.audioPill.style.display = 'none';
    this._paintMicState();
    this._updateMotionPill();
  }

  // ==============================================================================
  // DIAGNOSTICO REAL DE ENVIO DE AUDIO (2026-07-11, ver COORDINATION.md) - investigando el
  // backchannel HASS->altavoz del doorbell reportado como mudo, confirmado EXCLUSIVO de esta
  // card (dashboard web y apps si funcionan bidireccional, descarta firmware/protocolo). Sondea
  // pc.getStats() del sender de audio (outbound-rtp) cada 3s mientras el mic esta activo - es la
  // UNICA forma de saber con certeza si el navegador esta enviando bytes reales de verdad, en vez
  // de asumirlo porque getUserMedia()/replaceTrack() no lanzaron ninguna excepcion. Quitar/bajar
  // de nivel una vez cerrado el problema real.
  // ==============================================================================
  _startAudioSendDiagnostics() {
    this._stopAudioSendDiagnostics();
    this._audioSendPrevBytes = null;
    this._audioSendDiagTimer = setInterval(async () => {
      if (!this.pc || !this.audioTransceiver || !this.audioTransceiver.sender) return;
      try {
        const stats = await this.audioTransceiver.sender.getStats();
        let found = false;
        stats.forEach((report) => {
          if (report.type === 'outbound-rtp' && report.kind === 'audio') {
            found = true;
            const delta = this._audioSendPrevBytes === null ? 'n/a' : (report.bytesSent - this._audioSendPrevBytes);
            console.log(
              '[ig-doorbell-card DIAG audio] outbound-rtp audio: ' +
              `bytesSent=${report.bytesSent} (+${delta} desde el ultimo chequeo de 3s) packetsSent=${report.packetsSent}`
            );
            if (this._audioSendPrevBytes !== null && report.bytesSent === this._audioSendPrevBytes) {
              console.warn('[ig-doorbell-card DIAG audio] AVISO: bytesSent NO ha subido en los ultimos 3s - el navegador no esta enviando audio real pese a que replaceTrack() no fallo. Revisar getUserMedia (permiso/dispositivo) y currentDirection del transceiver.');
            }
            this._audioSendPrevBytes = report.bytesSent;
          }
        });
        if (!found) {
          console.warn('[ig-doorbell-card DIAG audio] AVISO: no hay ninguna entrada outbound-rtp de audio en getStats() - no hay ningun sender de audio activo a nivel de transporte.');
        }
      } catch (err) {
        console.warn('[ig-doorbell-card DIAG audio] getStats() del sender de audio fallo', err);
      }
    }, 3000);
  }

  _stopAudioSendDiagnostics() {
    if (this._audioSendDiagTimer) {
      clearInterval(this._audioSendDiagTimer);
      this._audioSendDiagTimer = null;
    }
    this._audioSendPrevBytes = null;
  }

  setupRemoteStream(stream) {
    if (this.videoEl.srcObject !== stream) {
      this._mark('setupRemoteStream: pc.ontrack disparado (stream remoto asignado al <video>)');
      // Señal de vida real + reseteo del backoff de reconexion - una sesion que llega hasta
      // aqui se considera recuperada de verdad, no solo "conectada a nivel de señalización"
      // (2026-07-10, ver COORDINATION.md Q19).
      this._recordLifeSignal();
      this._reconnectAttempt = 0;
      // Hay video: sea cual sea el camino, este portero SI acepta esta credencial. Si habia un
      // aviso de emparejamiento rechazado colgado, deja de ser cierto y se retira.
      this._clearPairingRejected();
      // §1.0: todo indicador TERMINA. La cuenta atras de reintento y cualquier aviso de espera se
      // retiran en el mismo instante en que hay imagen, que es la unica prueba de que se acabo.
      this._stopRetryCountdown();
      if (this.statusLine && this.statusLine.classList.contains('warn')) this._resetStatusLine();
      this.videoEl.srcObject = stream;
      // MUDO salvo que el usuario ya lo hubiera abierto a proposito en esta misma card (§1.10):
      // una reconexion no debe dejar sordo a quien estaba escuchando, pero tampoco encender el
      // sonido de una sesion nueva por su cuenta.
      this.videoEl.muted = !this._audioOn;
      this.videoEl.volume = parseFloat(this.volSlider.value);
      this.videoEl.play().catch(() => {});
      this._paintAudioState();

      this._setLiveState('live');
      this.micButton.removeAttribute('disabled');
      if (this.unlockButton) this.unlockButton.removeAttribute('disabled');

      if (this.loader) {
        this.loader.style.opacity = '0';
        setTimeout(() => this.loader.style.pointerEvents = 'none', 300);
      }

      // Timestamp mas preciso que 'ontrack' (mas arriba): el momento real en que el navegador
      // PINTA el primer frame decodificado, que es lo que el usuario percibe como "ya hay
      // video" - ontrack solo marca cuando llega el stream a nivel de transporte, no cuando se
      // ve algo en pantalla. requestVideoFrameCallback esta soportado en Chrome/Edge/Safari 16+
      // (no en todos los navegadores/versiones) - por eso el guard, con onloadeddata como
      // fallback razonable donde no exista.
      if (typeof this.videoEl.requestVideoFrameCallback === 'function') {
        this.videoEl.requestVideoFrameCallback(() => {
          this._mark('primer frame de video REALMENTE pintado en pantalla (requestVideoFrameCallback)');
        });
      } else {
        this.videoEl.addEventListener('loadeddata', () => {
          this._mark('primer frame de video con datos cargados (evento loadeddata, fallback sin requestVideoFrameCallback)');
        }, { once: true });
      }
    }
  }

  triggerUnlock() {
    if (!this._hass || !this.config.unlock_entity) return;
    const entityId = this.config.unlock_entity;
    const domain = entityId.split('.')[0];

    let duration = parseInt(this.config.unlock_duration) || 3;
    // Bug real encontrado y corregido (2026-07-10, ver COORDINATION.md): el README/config ya
    // anunciaba "cover" como dominio soportado para unlock_entity (p.ej. una verja/portón), pero
    // este switch caia al "else" y llamaba a cover.turn_on - un servicio que NO EXISTE en el
    // dominio cover de HA (lanza ServiceNotFound; el dominio cover usa open_cover/close_cover/
    // stop_cover, nunca turn_on/turn_off, verificado contra la documentacion real de HA, no
    // asumido). Cualquier usuario que configurara de verdad una entidad cover aqui habria visto
    // fallar la apertura en silencio (error en el log de HA, sin feedback visible en la card).
    let service;
    if (domain === 'button') service = 'press';
    else if (domain === 'lock') service = 'unlock';
    else if (domain === 'cover') service = 'open_cover';
    else service = 'turn_on'; // switch, light, y cualquier otro dominio generico con turn_on/off

    // §1.0: se enseña "Abriendo" DESDE EL PRIMER INSTANTE y se espera a que Home Assistant acepte
    // la llamada, en vez de pintar "Abierta" y cruzar los dedos. Aqui no hay un `open_result` del
    // portero -- la apertura la hace una entidad de HA -- pero si hay algo que esperar: que el
    // servicio se despache sin error. Un dominio equivocado o una entidad que ya no existe
    // fallaban antes en SILENCIO, con el boton en verde y la puerta cerrada.
    this._paintDoorOpening();
    Promise.resolve(this._hass.callService(domain, service, { entity_id: entityId }))
      .then(() => {
        this._clearDoorWait();
        this.unlockButton.classList.add('active-unlock');
        this.unlockIcon.setAttribute('icon', 'mdi:door-open');
        this._setDoorLabel(true);
        this._startDoorCountdown(duration);
        // El cierre automatico se programa DESDE AQUI, no en paralelo a la apertura: si la
        // apertura fallo no hay nada que cerrar, y mandar un turn_off a una entidad que nunca se
        // encendio es ruido en el registro de alguien que ya tiene un problema.
        setTimeout(() => {
          this.unlockButton.classList.remove('active-unlock');
          this.unlockIcon.setAttribute('icon', 'mdi:key');
          this._setDoorLabel(false);
          if (domain === 'switch' || domain === 'light') {
            this._hass.callService(domain, 'turn_off', { entity_id: entityId });
          } else if (domain === 'cover') {
            this._hass.callService(domain, 'close_cover', { entity_id: entityId });
          }
        }, duration * 1000);
      })
      .catch((err) => {
        this._clearDoorWait();
        this.unlockIcon.setAttribute('icon', 'mdi:key');
        this._setDoorLabel(false);
        console.error(`[ig-doorbell-card] Home Assistant rechazo ${domain}.${service} sobre ${entityId}`, err);
        this._flashStatusLine('door_no_answer', 6000);
      });
  }

  injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      ig-doorbell-card { display: block; width: 100%; box-sizing: border-box; }

      /* Paleta exacta del mockup Figma (android_app/ios_app) - ver COORDINATION.md Q22-bis en
         ig_hassio_addons. Custom properties escopadas a .ig-container (no a :root - esta
         card no usa Shadow DOM, asi que :root filtraria al documento entero de HA). */
      .ig-container {
        /* Valores EXACTOS confirmados contra el codigo fuente real de android_app/ios_app
           (2026-07-10, ver COORDINATION.md Q22-bis) - no aproximados de una captura. */
        --ig-lime:#78C800; --ig-cyan:#00C4D4; --ig-blue:#1976D2; --ig-blue-dark:#1565C0;
        --ig-bg:#070D1A; --ig-surf1:#0D1B2E; --ig-surf2:#162336; --ig-surf3:#1D2D42;
        --ig-text:#E8F0FE; --ig-muted:#94A3B8; --ig-dim:#64748B; --ig-faint:#334155;
        --ig-green:#4CAF50; --ig-red:#EF5350; --ig-amber:#FFB300; --ig-indigo:#818CF8;
        position: relative; width: 100%; box-sizing: border-box; background: var(--ig-bg);
        font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
        padding: 10px; display: flex; flex-direction: column; gap: 10px;
      }

      ha-card { display: block; width: 100%; box-sizing: border-box; overflow: hidden; border-radius: var(--ha-card-border-radius, 12px); box-shadow: var(--ha-card-box-shadow, 0px 2px 4px -1px rgba(0,0,0,0.2)); background: #070D1A; }

      /* ---- chips de modo (opcional, requiere mode_entity) ---- */
      .mode-row { display: flex; gap: 6px; }
      .mode-row .chip {
        flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px;
        padding: 8px 4px; border-radius: 14px; background: var(--ig-surf1);
        border: 1px solid rgba(255,255,255,0.05); font-size: 10.5px; color: var(--ig-dim);
        font-weight: 600; cursor: pointer; font-family: inherit;
      }
      .mode-row .chip ha-icon { --mdc-icon-size: 16px; }
      .mode-row .chip.active { color: #fff; }
      .mode-row .chip.active.mode-normal { background: rgba(120,200,0,0.14); border-color: rgba(120,200,0,0.4); color: var(--ig-lime); }
      .mode-row .chip.active.mode-away { background: rgba(255,179,0,0.14); border-color: rgba(255,179,0,0.4); color: var(--ig-amber); }
      .mode-row .chip.active.mode-night { background: rgba(129,140,248,0.14); border-color: rgba(129,140,248,0.4); color: var(--ig-indigo); }
      .mode-row .chip.active.mode-custom { background: rgba(0,196,212,0.14); border-color: rgba(0,196,212,0.4); color: var(--ig-cyan); }

      /* ---- marco de video redondeado + HUD superpuesto ---- */
      .feed-wrap {
        /* Container query, no media query (2026-07-26): el HUD tiene que adaptarse al ancho de
           la CARD, que en Home Assistant no tiene nada que ver con el ancho de la ventana - una
           card estrecha en una columna de un dashboard de escritorio ancho es un caso normal, y
           una @media la habria tratado como "pantalla grande". Ver reglas @container abajo. */
        container-type: inline-size; container-name: igfeed;
        position: relative; width: 100%; border-radius: 22px; overflow: hidden;
        border: 1px solid rgba(255,255,255,0.06);
        background: radial-gradient(ellipse at 30% 20%, rgba(60,80,110,0.35), transparent 60%),
                    linear-gradient(180deg, #1b2536 0%, #0d1420 55%, #070a12 100%);
      }
      .video-wrapper { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
      .video-wrapper video { width: 100%; height: 100%; object-fit: contain; }

      /* pointer-events:none desde el principio (2026-07-29). El velo de carga cubre el marco
         entero con z-index 10 y hasta ahora solo dejaba de interceptar clicks cuando llegaba el
         primer fotograma (inline, desde setupRemoteStream). Efecto real: mientras la card
         conectaba - que con el portero apagado o desde fuera de casa puede ser bastante rato -
         ningun control del HUD respondia, incluido el boton de pantalla completa; y tras una
         reconexion el velo volvia a opacidad 1 pero SIN volver a interceptar, asi que el
         comportamiento ni siquiera era consistente consigo mismo. El velo no tiene nada que se
         pueda pulsar: es decoracion, y la decoracion no debe robar clicks. */
      .ig-loader-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(7,10,18,0.85); z-index: 10; display: flex; align-items: center; justify-content: center; transition: opacity 0.3s ease; pointer-events: none; }
      .ig-ring { position: absolute; width: 60px; height: 60px; border: 4px solid rgba(0,196,212,0.2); border-top-color: var(--ig-cyan); border-radius: 50%; animation: ig-spin 1s linear infinite; }
      .ig-logo { position: absolute; color: #fff; font-family: system-ui, sans-serif; font-weight: 800; font-size: 16px; letter-spacing: 1px; }
      @keyframes ig-spin { 100% { transform: rotate(360deg); } }

      .hud-top { position: absolute; top: 12px; left: 14px; right: 14px; display: flex; align-items: flex-start; justify-content: space-between; z-index: 5; pointer-events: none; }
      .hud-top-left { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

      /* Contador de clientes WebRTC (§1.4-ter #2). Discreto cuando estas solo (el caso normal),
         resaltado en cian solo cuando hay MAS de uno - que es el dato que cambia como te
         comportas ("alguien mas esta mirando/puede hablar"). */
      .clients-pill {
        display: flex; align-items: center; gap: 4px; pointer-events: auto;
        background: rgba(7,13,26,0.72); backdrop-filter: blur(6px);
        border: 1px solid rgba(255,255,255,0.12); border-radius: 999px; padding: 4px 9px;
        font-size: 10.5px; font-weight: 700; color: var(--ig-muted); font-variant-numeric: tabular-nums;
      }
      .clients-pill ha-icon { --mdc-icon-size: 13px; }
      .clients-pill.multi { color: var(--ig-cyan); border-color: rgba(0,196,212,0.45); background: rgba(0,196,212,0.16); }

      .live-tag {
        display: flex; align-items: center; gap: 6px; pointer-events: auto;
      }
      .live-tag .reddot { width: 7px; height: 7px; border-radius: 50%; background: var(--ig-cyan); box-shadow: 0 0 8px var(--ig-cyan); flex-shrink: 0; }
      .live-tag[data-state="live"] .reddot, .live-tag[data-state="open"] .reddot { background: var(--ig-red); box-shadow: 0 0 8px var(--ig-red); animation: ig-pulse 1.4s infinite; }
      .live-tag[data-state="error"] .reddot { background: var(--ig-red); box-shadow: 0 0 8px var(--ig-red); }
      .live-tag[data-state="warn"] .reddot { background: var(--ig-amber); box-shadow: 0 0 8px var(--ig-amber); }
      @keyframes ig-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
      .status-badge {
        background: rgba(7,13,26,0.72); backdrop-filter: blur(6px); color: var(--ig-text);
        padding: 5px 10px; border-radius: 999px; font-size: 10.5px; font-weight: 700;
        letter-spacing: 0.04em; border: 1px solid rgba(255,255,255,0.12);
        font-family: inherit; transition: all 0.3s ease;
      }

      /* Reloj superpuesto arriba-dcha - mono, tal cual el mockup (hora grande + fecha pequeña). */
      .hud-time { text-align: right; font-family: 'Consolas', 'Roboto Mono', monospace; font-variant-numeric: tabular-nums; }
      .hud-time .hm { font-size: 15px; font-weight: 700; color: var(--ig-text); line-height: 1.1; text-shadow: 0 1px 3px rgba(0,0,0,0.6); }
      .hud-time .ymd { font-size: 10px; color: rgba(232,240,254,0.75); text-shadow: 0 1px 3px rgba(0,0,0,0.6); }

      .hud-bottom-right { display: flex; align-items: center; gap: 6px; margin-left: auto; }

      /* Selector de calidad (§1.4-ter #3), en el mismo cluster de controles reales de la esquina
         inferior-dcha que el volumen y las barras de señal. El menu se abre HACIA ARRIBA
         (bottom:100%) para no salirse del marco de video en una card baja, y con
         position:absolute para no empujar el resto del HUD al abrirse. */
      .hud-quality { position: relative; pointer-events: auto; }
      .q-btn {
        display: flex; align-items: center; gap: 5px; cursor: pointer; font-family: inherit;
        background: rgba(7,13,26,0.55); border: 1px solid rgba(255,255,255,0.12);
        border-radius: 999px; padding: 5px 10px; color: var(--ig-text);
        font-size: 10.5px; font-weight: 700; letter-spacing: 0.02em;
      }
      .q-btn ha-icon { --mdc-icon-size: 14px; }
      .q-btn:hover { border-color: rgba(0,196,212,0.5); }
      .q-menu {
        position: absolute; bottom: calc(100% + 6px); right: 0; z-index: 20;
        display: flex; flex-direction: column; gap: 2px; padding: 5px;
        background: rgba(13,27,46,0.96); backdrop-filter: blur(8px);
        border: 1px solid rgba(255,255,255,0.12); border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5); min-width: 132px;
      }
      .q-menu .q-opt {
        display: flex; align-items: center; gap: 8px; width: 100%; cursor: pointer;
        background: transparent; border: none; border-radius: 8px; padding: 7px 9px;
        color: var(--ig-muted); font-size: 11.5px; font-weight: 600; font-family: inherit; text-align: left;
      }
      .q-menu .q-opt ha-icon { --mdc-icon-size: 15px; flex-shrink: 0; }
      /* Segunda linea explicativa por opcion: "Baja" es ~1 imagen/s, no video fluido de menos
         calidad - sin decirlo, se percibe como averia (ver QUALITY_MODES). */
      .q-menu .q-txt { display: flex; flex-direction: column; line-height: 1.25; }
      .q-menu .q-txt b { font-weight: 700; }
      .q-menu .q-txt i { font-style: normal; font-size: 10px; font-weight: 500; color: var(--ig-dim); }
      .q-menu .q-opt.sel .q-txt i { color: rgba(0,196,212,0.75); }
      .q-menu .q-opt:hover { background: rgba(255,255,255,0.06); color: var(--ig-text); }
      .q-menu .q-opt.sel { background: rgba(0,196,212,0.16); color: var(--ig-cyan); }
      .hud-vol {
        display: flex; align-items: center; gap: 6px; background: rgba(7,13,26,0.55);
        border-radius: 999px; padding: 5px 10px; pointer-events: auto;
      }
      .hud-vol input[type=range] { width: 56px; accent-color: var(--ig-cyan); cursor: pointer; }
      .hud-vol ha-icon { --mdc-icon-size: 16px; color: var(--ig-text); }
      /* Control de sonido (§1.10). En reposo esta MUDO, y eso tiene que leerse de un vistazo: el
         icono tachado en gris apagado, y en cian encendido cuando de verdad se oye. Un control de
         sonido cuyo estado hay que adivinar es peor que no tenerlo, porque el usuario cree que
         esta oyendo. */
      .snd-btn {
        display: flex; align-items: center; justify-content: center; cursor: pointer;
        background: transparent; border: none; padding: 0; margin: 0;
        color: var(--ig-dim); font-family: inherit;
      }
      .snd-btn ha-icon { --mdc-icon-size: 16px; color: inherit; }
      .snd-btn.on { color: var(--ig-cyan); }
      .snd-btn:hover { color: var(--ig-text); }

      /* Boton de pantalla completa, ultimo del cluster derecho. */
      .hud-fs {
        display: flex; align-items: center; justify-content: center; cursor: pointer;
        background: rgba(7,13,26,0.55); border: 1px solid rgba(255,255,255,0.12);
        border-radius: 999px; padding: 5px; color: var(--ig-text); pointer-events: auto;
        font-family: inherit;
      }
      .hud-fs ha-icon { --mdc-icon-size: 18px; }
      .hud-fs:hover { border-color: rgba(0,196,212,0.5); }
      .hud-fs.on { color: var(--ig-cyan); border-color: rgba(0,196,212,0.5); }

      /* Barras de señal esquina inferior-dcha (mockup) - reflejan el estado real de conexion
         (data-state, propagado tambien a .feed-wrap desde _setLiveState()) en vez de una metrica
         WiFi que esta card no tiene forma de conocer - una adaptacion honesta del elemento, no
         una imitacion literal de un dato que no existe aqui. */
      .hud-sig { display: flex; align-items: flex-end; gap: 2px; height: 12px; background: rgba(7,13,26,0.55); border-radius: 999px; padding: 6px 8px; }
      .hud-sig i { width: 3px; border-radius: 1px; background: rgba(255,255,255,0.2); display: block; }
      .hud-sig i:nth-child(1) { height: 25%; }
      .hud-sig i:nth-child(2) { height: 50%; }
      .hud-sig i:nth-child(3) { height: 75%; }
      .hud-sig i:nth-child(4) { height: 100%; }
      .feed-wrap[data-state="live"] .hud-sig i, .feed-wrap[data-state="open"] .hud-sig i { background: var(--ig-text); }
      .feed-wrap[data-state="connecting"] .hud-sig i:nth-child(-n+2) { background: rgba(232,240,254,0.6); }
      .feed-wrap[data-state="error"] .hud-sig i:nth-child(1) { background: var(--ig-red); }
      .feed-wrap[data-state="warn"] .hud-sig i:nth-child(-n+3) { background: var(--ig-amber); }

      .motion-pill {
        position: absolute; top: 44px; left: 50%; transform: translateX(-50%); z-index: 6;
        display: flex; align-items: center; gap: 5px; background: rgba(255,179,0,0.92);
        border-radius: 999px; padding: 5px 11px;
      }
      .motion-pill ha-icon { --mdc-icon-size: 13px; color: #1a1300; }
      .motion-pill span { font-size: 10.5px; font-weight: 700; color: #1a1300; }

      /* justify-content:flex-start (no space-between) a proposito: audio-pill esta oculto la
         mayoria del tiempo (solo con el mic activo) - con space-between y un solo hijo visible,
         ese hijo quedaria pegado a la IZQUIERDA (comportamiento real del flexbox con 1 item), no
         a la derecha donde debe estar el cluster de volumen+señal siempre. margin-left:auto en
         .hud-bottom-right lo empuja al borde derecho de forma robusta pase lo que pase con
         audio-pill. */
      .hud-bottom { position: absolute; bottom: 12px; left: 14px; right: 14px; display: flex; align-items: center; justify-content: flex-start; gap: 8px; z-index: 5; flex-wrap: wrap; }
      .audio-pill {
        display: flex; align-items: center; gap: 6px; background: rgba(0,196,212,0.18);
        border: 1px solid rgba(0,196,212,0.4); border-radius: 999px; padding: 5px 10px;
      }
      .audio-pill ha-icon { --mdc-icon-size: 13px; color: #bdf3f8; }
      .audio-pill span { font-size: 10px; font-weight: 600; color: #bdf3f8; }

      /* ---- HUD en cards estrechas (movil en vertical, o una columna estrecha en escritorio) ----
         El cluster inferior-derecho paso de 2 piezas (volumen + señal) a 3 al añadirse el
         selector de calidad, y con la pildora "Audio activo" a la izquierda ya no cabe todo en
         ~360px. Prioridad al desalojar: primero las barras de señal (decorativas, su informacion
         ya esta en el live-tag de arriba), luego se encoge el slider de volumen, y en el ultimo
         escalon el selector de calidad se queda solo con el icono. Nada se oculta si es la unica
         forma de acceder a una funcion. */
      @container igfeed (max-width: 460px) {
        .hud-sig { display: none; }
        .hud-vol input[type=range] { width: 40px; }
      }
      @container igfeed (max-width: 340px) {
        .q-btn span { display: none; }
        .hud-vol input[type=range] { width: 28px; }
        .hud-time .ymd { display: none; }
      }

      /* ---- linea de estado bajo el video (puerta), distinta del live-tag (conexion) ---- */
      .status-line { font-size: 12px; text-align: center; color: var(--ig-dim); font-weight: 500; }
      .status-line.open { color: var(--ig-green); font-weight: 600; }
      .status-line.warn { color: var(--ig-amber); font-weight: 600; }

      /* ---- botones de accion asimetricos: mic protagonista, puerta secundario ---- */
      .actions-row { display: flex; justify-content: center; align-items: flex-end; gap: 30px; padding: 2px 4px 4px; }
      .action { display: flex; flex-direction: column; align-items: center; gap: 6px; }
      .action .btn {
        border-radius: 50%; border: 2px solid rgba(255,255,255,0.08); cursor: pointer;
        display: flex; align-items: center; justify-content: center; position: relative;
        background: linear-gradient(135deg, var(--ig-surf2), var(--ig-surf3));
        box-shadow: 0 6px 18px rgba(0,0,0,0.4); color: var(--ig-muted); transition: all 0.3s ease;
      }
      .action .btn:disabled { opacity: 0.5; cursor: not-allowed; }
      /* 80px/60px EXACTOS confirmados contra el codigo fuente real (2026-07-10, antes 76/56
         aproximados de la reconstruccion visual) - ver COORDINATION.md Q22-bis. */
      .action .btn.mic { width: 80px; height: 80px; }
      .action .btn.mic ha-icon { --mdc-icon-size: 30px; }
      .action .btn.door { width: 60px; height: 60px; }
      .action .btn.door ha-icon { --mdc-icon-size: 24px; }
      .action .btn.active-talk { background: linear-gradient(135deg, var(--ig-cyan), var(--ig-blue)); border-color: transparent; box-shadow: 0 0 28px rgba(0,196,212,0.45), 0 8px 24px rgba(0,0,0,0.4); color: var(--ig-text); transform: scale(1.05); }
      .action .btn.active-unlock { background: linear-gradient(135deg, var(--ig-green), #388E3C); border-color: transparent; box-shadow: 0 0 22px rgba(76,175,80,0.5); color: var(--ig-text); transform: scale(1.05); }
      .pulsering { position: absolute; inset: 0; border-radius: 50%; border: 2px solid var(--ig-cyan); animation: ig-ring 1.2s infinite; pointer-events: none; display: none; }
      .action .btn.active-talk .pulsering { display: block; }
      @keyframes ig-ring { 0% { transform: scale(1); opacity: 0.55; } 100% { transform: scale(1.55); opacity: 0; } }
      .action .lbl { font-size: 12px; font-weight: 500; color: var(--ig-dim); }
      .action .lbl.on-cyan { color: var(--ig-cyan); }
      .action .lbl.on-green { color: var(--ig-green); }
      .action .lbl.on-amber { color: var(--ig-amber); }

      /* ---- estados del boton de micro introducidos por el turno de palabra (§1.4-ter #1) ----
         Los tres son visualmente DISTINTOS entre si y del "hablando" (cian): pidiendo turno
         (ambar pulsante), solo escucha (ambar fijo, turno denegado pero se oye al portero) y
         ocupado por otro (contorno ambar tenue, sin llegar a parecer deshabilitado - se puede
         pulsar, y el portero contesta con un talk_denied explicito). */
      .action .btn.requesting { border-color: var(--ig-amber); color: var(--ig-amber); animation: ig-breathe 1.1s ease-in-out infinite; }
      .action .btn.listen-only { background: linear-gradient(135deg, var(--ig-surf3), #2a3a52); border-color: var(--ig-amber); color: var(--ig-amber); }
      .action .btn.busy-other { border-color: rgba(255,179,0,0.45); color: rgba(255,179,0,0.8); }
      @keyframes ig-breathe { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }

      /* ---- confirmacion de apertura (§1.8): estado ARMADO del boton de puerta ----
         Ambar, no verde: verde es "abierta" y esto todavia no ha abierto nada. El anillo que se
         encoge es la cuenta atras de los 3 segundos - el contrato la pide "si se puede", y aqui se
         puede sin ningun temporizador en JS. Sin ella, un boton armado se ve igual el primer
         segundo que el tercero y el usuario no sabe si aun le vale pulsar. */
      .action .btn.confirming {
        border-color: var(--ig-amber); color: var(--ig-amber);
        background: linear-gradient(135deg, rgba(255,179,0,0.18), rgba(255,179,0,0.06));
        box-shadow: 0 0 22px rgba(255,179,0,0.35);
      }
      .action .btn.confirming::after {
        content: ''; position: absolute; inset: -4px; border-radius: 50%;
        border: 2px solid var(--ig-amber); animation: ig-armed 3s linear forwards;
        pointer-events: none;
      }
      @keyframes ig-armed { 0% { transform: scale(1.25); opacity: 0.9; } 100% { transform: scale(1); opacity: 0; } }

      /* ---- estado ABRIENDO (§1.0): se ha mandado el mensaje de apertura y se espera respuesta --
         Visualmente distinto del verde de "abierta", que es la afirmacion que no se puede
         adelantar. El icono gira mientras dura: una accion que tarda tiene que verse en curso
         desde el primer instante, y este estado SIEMPRE termina - o llega open_result, o salta el
         plazo de 6s y se dice que no hubo respuesta. */
      .action .btn.opening { border-color: var(--ig-amber); color: var(--ig-amber); }
      .action .btn.opening ha-icon { animation: ig-spin 1s linear infinite; }

      /* ==========================================================================
         PANTALLA COMPLETA. Un SOLO juego de reglas para los dos niveles
         (API nativa y respaldo propio), gobernado por el atributo [data-fs] - ver
         _applyFullscreenUI(). La unica diferencia entre niveles es el bloque .ig-fs-pseudo de
         mas abajo: en pantalla completa nativa quien coloca el elemento es el navegador.

         Los !important de .feed-wrap no son un atajo: el alto/la proporcion del marco de video
         se fijan como estilo EN LINEA desde render() (opcion 'height' de la card), y un estilo en
         linea gana a cualquier regla normal de esta hoja. Es el caso justo para el que existe
         !important, no una pelea de especificidad inventada.
         ========================================================================== */
      ig-doorbell-card[data-fs] { height: 100%; background: #000; }
      /* Contenedor de emergencia al que se traslada la card cuando un ancestro atrapa el
         position:fixed. No lleva estilos propios a proposito: quien se posiciona es el
         contenedor de la card, y un host con caja propia solo podria estorbar. */
      .ig-fs-host { display: contents; }
      ig-doorbell-card[data-fs] ha-card {
        height: 100%; border-radius: 0; box-shadow: none; border: none;
      }
      .ig-container.ig-fs {
        height: 100%; padding: 0; gap: 0; background: #000;
      }
      /* La fila de chips de modo se retira: el modo del sistema es configuracion, no algo que se
         atienda con alguien esperando en la puerta. Los dos botones que el contrato pide (micro y
         abrir) siguen ahi, flotando sobre la imagen. */
      .ig-container.ig-fs .mode-row { display: none !important; }
      .ig-container.ig-fs .feed-wrap {
        position: absolute; inset: 0; width: 100%;
        height: 100% !important; aspect-ratio: auto !important;
        border-radius: 0; border: none;
      }
      /* object-fit contain, no cover: recortar para llenar el hueco dejaria a quien esta en la puerta
         fuera del encuadre segun la forma de la pantalla. En un videoportero eso no es un detalle
         estetico. */
      .ig-container.ig-fs .video-wrapper video { object-fit: contain; }

      /* Los dos botones, flotando sobre la imagen. NO se ocultan solos: no hay ningun temporizador
         que los esconda, a proposito. */
      .ig-container.ig-fs .actions-row {
        position: absolute; left: 0; right: 0; bottom: 16px; z-index: 8;
        padding: 0; gap: 34px; pointer-events: none;
      }
      /* Velo degradado bajo los controles flotantes. No es adorno: sobre una imagen clara (un
         portal a mediodia) el texto blanco de las etiquetas y la linea de estado se vuelve
         ilegible, y aqui lo que hay que leer es "Puerta abierta" o "canal ocupado". */
      .ig-container.ig-fs .feed-wrap::after {
        content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 210px;
        background: linear-gradient(180deg, transparent, rgba(0,0,0,0.55) 60%, rgba(0,0,0,0.72));
        pointer-events: none; z-index: 4;
      }
      .ig-container.ig-fs .actions-row .action { pointer-events: auto; }
      .ig-container.ig-fs .action .btn {
        box-shadow: 0 6px 22px rgba(0,0,0,0.65);
        background: linear-gradient(135deg, rgba(22,35,54,0.92), rgba(29,45,66,0.92));
        backdrop-filter: blur(6px);
      }
      .ig-container.ig-fs .action .lbl {
        color: rgba(232,240,254,0.9); text-shadow: 0 1px 4px rgba(0,0,0,0.8);
      }
      /* La linea de estado (puerta abierta, canal ocupado, sin cerradura) tambien flota: es donde
         se contesta al usuario cuando pulsa, y dejarla fuera de la vista en este modo la haria
         inutil justo cuando mas se usa. */
      /* Justo encima de los botones (que ocupan 16px de margen + 80 de boton + 6 + etiqueta). */
      .ig-container.ig-fs .status-line {
        position: absolute; left: 0; right: 0; bottom: 136px; z-index: 7;
        pointer-events: none; text-shadow: 0 1px 4px rgba(0,0,0,0.85);
        color: rgba(232,240,254,0.85);
      }
      /* El cluster inferior del HUD (volumen, calidad, pantalla completa) se queda abajo a la
         DERECHA: los botones de accion van centrados, asi que en una pantalla ancha no se tocan y
         es donde el usuario ya los tiene aprendidos del modo normal. Solo cuando no caben los dos
         a lo ancho - un movil en vertical - sube por encima. Medido, no estimado: con 412px de
         ancho el bloque centrado ocupa ~119..293 y el cluster derecho ~253..398, es decir 40px de
         solape real. La consulta es de CONTENEDOR (el propio marco de video), no de ventana, por
         el mismo motivo que el resto de la card: lo que manda es el ancho del video. */
      @container igfeed (max-width: 520px) {
        .ig-container.ig-fs .hud-bottom { bottom: 174px; }
      }

      /* ==========================================================================
         CARRIL LATERAL - video VERTICAL dentro de un marco APAISADO (§1.9)
         El caso real es una tablet de pared, que vive en apaisado permanentemente. Un video
         vertical ahi ocupa una franja central y deja dos huecos grandes a los lados.
         La solucion NO es recortar para llenar: eso tira la parte de arriba y la de abajo, que es
         justo lo que se gano girando el sensor. La solucion es USAR uno de esos huecos.
         Reglas que no admiten interpretacion, de la correccion de Iñaki al ver iOS:
          - El video ocupa TODA la altura, de extremo a extremo. En apaisado la altura es el
            recurso escaso.
          - El carril es solo tan ancho como el objetivo tactil que contiene (RAIL_WIDTH en JS).
            Una columna de botones, no un panel: el ancho que se lleva el carril es alto que
            pierde el video.
         La clase la pone _layoutRotation() midiendo el marco de verdad, no una @container: este
         contenedor es de tipo inline-size y por tanto no puede consultarse por proporcion.
         ========================================================================== */
      .ig-container.ig-fs.ig-rail .actions-row {
        left: auto; right: 0; bottom: auto; top: 50%;
        transform: translateY(-50%);
        width: 104px; flex-direction: column; align-items: center; gap: 22px;
      }
      /* El velo de legibilidad pasa de la banda inferior al lateral, que es donde estan ahora los
         controles. */
      .ig-container.ig-fs.ig-rail .feed-wrap::after {
        left: auto; right: 0; top: 0; bottom: 0; width: 168px; height: auto;
        background: linear-gradient(90deg, transparent, rgba(0,0,0,0.55) 55%, rgba(0,0,0,0.72));
      }
      /* La linea de estado vuelve abajo del todo: encima de los botones ya no hay botones. */
      .ig-container.ig-fs.ig-rail .status-line { bottom: 14px; right: 112px; left: 0; }
      /* Y el cluster del HUD se aparta del carril para no solaparse con el. */
      .ig-container.ig-fs.ig-rail .hud-bottom { right: 118px; bottom: 12px; }

      /* Nivel 2: respaldo propio. El tamano lo dan 'inset: 0' y 'width/height: auto', NO unidades
         de viewport, y eso es deliberado: '100vw' INCLUYE la barra de desplazamiento y el bloque
         contenedor de un position:fixed no. En un dashboard con scroll -- la mayoria de los
         reales -- '100vw' deja el elemento unos 10-17px mas ancho que la zona visible y provoca
         desbordamiento horizontal. Con 'inset: 0' el elemento mide exactamente el viewport
         visible, que es lo que se quiere y ademas lo que hace comparable la comprobacion de
         _enterFullscreen().
         Los !important estan para ganarle al 'width: 100%' que se fija como estilo EN LINEA
         sobre el propio elemento (ver setConfig) y al 'height: 100%' del modo. */
      .ig-container.ig-fs-pseudo {
        position: fixed; inset: 0; z-index: 2147483000;
        width: auto !important; height: auto !important; max-width: none;
      }
      body.ig-fs-body-lock { overflow: hidden !important; }
    `;
    this.appendChild(style);
  }
}

// ==============================================================================
// EDITOR VISUAL TRADUCIDO (A prueba de condiciones de carrera)
// ==============================================================================
class IgDoorbellCardEditor extends HTMLElement {
  set hass(hass) { 
    this._hass = hass;
    this.render(); // Dejamos que render() decida si tiene todo lo necesario
  }

  setConfig(config) {
    this._config = Object.assign({}, config);
    this.render(); // Dejamos que render() decida si tiene todo lo necesario
  }

  render() {
    // 🚀 EL FIX: Solo pintamos si tenemos config, hass, y no hemos pintado ya.
    if (!this._config || !this._hass || this._rendered) return;
    
    this.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 16px; padding: 8px 0;">
        <div style="display: flex; flex-direction: column;">
          <div id="device-picker-slot"></div>
          <input type="text" id="device_id_fallback" value="${this._config.device_id || ''}"
                 placeholder="${getLocalText(this._hass, 'ed_device_id')}"
                 style="display:none; margin-top:6px; padding: 10px; border: 1px solid var(--divider-color, #ccc); border-radius: 4px; background: var(--card-background-color, #fff); color: var(--primary-text-color);">
        </div>
        <div style="display: flex; flex-direction: column;">
          <label style="font-size: 14px; margin-bottom: 4px; color: var(--primary-text-color);">${getLocalText(this._hass, 'ed_entity')}</label>
          <input type="text" id="unlock_entity" value="${this._config.unlock_entity || ''}" style="padding: 10px; border: 1px solid var(--divider-color, #ccc); border-radius: 4px; background: var(--card-background-color, #fff); color: var(--primary-text-color);">
        </div>
        <div style="display: flex; flex-direction: column;">
          <label style="font-size: 14px; margin-bottom: 4px; color: var(--primary-text-color);">${getLocalText(this._hass, 'ed_mode_entity')}</label>
          <input type="text" id="mode_entity" value="${this._config.mode_entity || ''}" style="padding: 10px; border: 1px solid var(--divider-color, #ccc); border-radius: 4px; background: var(--card-background-color, #fff); color: var(--primary-text-color);">
        </div>
        <div style="display: flex; flex-direction: column;">
          <label style="font-size: 14px; margin-bottom: 4px; color: var(--primary-text-color);">${getLocalText(this._hass, 'ed_motion_entity')}</label>
          <input type="text" id="motion_entity" value="${this._config.motion_entity || ''}" style="padding: 10px; border: 1px solid var(--divider-color, #ccc); border-radius: 4px; background: var(--card-background-color, #fff); color: var(--primary-text-color);">
        </div>
        <div style="display: flex; flex-direction: column;">
          <label style="font-size: 14px; margin-bottom: 4px; color: var(--primary-text-color);">${getLocalText(this._hass, 'ed_ring_entity')}</label>
          <input type="text" id="ring_entity" value="${this._config.ring_entity || ''}" style="padding: 10px; border: 1px solid var(--divider-color, #ccc); border-radius: 4px; background: var(--card-background-color, #fff); color: var(--primary-text-color);">
        </div>
        <div style="display: flex; flex-direction: column;">
          <label style="font-size: 14px; margin-bottom: 4px; color: var(--primary-text-color);">${getLocalText(this._hass, 'ed_duration')}</label>
          <input type="number" id="unlock_duration" min="1" max="20" value="${this._config.unlock_duration || 3}" style="padding: 10px; border: 1px solid var(--divider-color, #ccc); border-radius: 4px; background: var(--card-background-color, #fff); color: var(--primary-text-color);">
        </div>
        <div style="display: flex; flex-direction: column;">
          <label style="font-size: 14px; margin-bottom: 4px; color: var(--primary-text-color);">${getLocalText(this._hass, 'ed_height')}</label>
          <input type="text" id="height" value="${this._config.height || 'auto'}" style="padding: 10px; border: 1px solid var(--divider-color, #ccc); border-radius: 4px; background: var(--card-background-color, #fff); color: var(--primary-text-color);">
        </div>
      </div>
    `;

    // device_id_fallback se gestiona aparte (mountDevicePicker) porque su valor real va a la
    // clave "device_id" de la config, no a "device_id_fallback" - se excluye del bucle generico.
    const inputs = this.querySelectorAll('input:not(#device_id_fallback)');
    inputs.forEach(input => {
      input.addEventListener('input', (e) => {
        this.updateConfigValue(e.target.id, e.target.value);
      });
    });

    this.mountDevicePicker();

    // Marcamos como dibujado SOLAMENTE cuando hemos puesto los inputs en pantalla
    this._rendered = true;
  }

  updateConfigValue(key, value) {
    if (!this._config) return;
    const newConfig = Object.assign({}, this._config);
    if (value === '') delete newConfig[key];
    else newConfig[key] = value;

    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: newConfig }, bubbles: true, composed: true }));
  }

  // Picker nativo de HA (mismo componente que usa el propio Home Assistant en sus formularios),
  // filtrado a los dispositivos de la integracion ig_doorbell - el usuario elige su
  // doorbell por nombre, sin copiar/pegar ningun device_id a mano. Requiere que la integracion
  // registre el dispositivo en el device registry (ver __init__.py::async_setup_entry en
  // islautopia-doorbell-integration) para que aparezca en la lista.
  mountDevicePicker() {
    const slot = this.querySelector('#device-picker-slot');
    const fallbackInput = this.querySelector('#device_id_fallback');
    if (!slot) return;

    if (!customElements.get('ha-selector')) {
      // Defensivo: si por lo que sea el frontend de HA no tiene ha-selector disponible, no
      // dejamos al usuario sin forma de configurar la card - se cae al campo de texto manual.
      console.warn('[ig-doorbell-card] ha-selector no disponible, usando campo de texto manual para device_id');
      if (fallbackInput) {
        fallbackInput.style.display = '';
        fallbackInput.addEventListener('input', (e) => this.updateConfigValue('device_id', e.target.value));
      }
      return;
    }

    const picker = document.createElement('ha-selector');
    picker.hass = this._hass;
    picker.selector = { device: { filter: { integration: 'ig_doorbell' } } };
    picker.label = getLocalText(this._hass, 'ed_device_id');
    picker.value = findHaDeviceIdForOurDeviceId(this._hass, this._config.device_id);

    picker.addEventListener('value-changed', (e) => {
      e.stopPropagation();
      const haDeviceId = e.detail.value;
      const ourDeviceId = findOurDeviceIdForHaDeviceId(this._hass, haDeviceId);
      this.updateConfigValue('device_id', ourDeviceId || '');
    });

    slot.appendChild(picker);
  }
}

// Resuelve entre el device_id propio del doorbell (el que usan websocket_api.py y el resto del
// API_CONTRACT.md) y el ID interno del device registry de HA (el que devuelve <ha-selector>) -
// via el identifier ["ig_doorbell", "<device_id>"] que el backend registra en cada
// dispositivo (__init__.py). Nunca se guarda el ID interno de HA en la config de la card: es
// menos estable a largo plazo que el device_id propio (derivado de la MAC del doorbell).
function findHaDeviceIdForOurDeviceId(hass, ourDeviceId) {
  if (!hass || !hass.devices || !ourDeviceId) return '';
  for (const haId in hass.devices) {
    const device = hass.devices[haId];
    if (device && Array.isArray(device.identifiers) &&
        device.identifiers.some((pair) => pair[0] === 'ig_doorbell' && pair[1] === ourDeviceId)) {
      return haId;
    }
  }
  return '';
}

function findOurDeviceIdForHaDeviceId(hass, haDeviceId) {
  if (!hass || !hass.devices || !haDeviceId) return '';
  const device = hass.devices[haDeviceId];
  if (!device || !Array.isArray(device.identifiers)) return '';
  const match = device.identifiers.find((pair) => pair[0] === 'ig_doorbell');
  return match ? match[1] : '';
}

// Guardas de idempotencia (encontrado en pruebas reales 2026-07-09, ver COORDINATION.md): si
// esta card sigue tambien instalada via HACS (recurso /hacsfiles/...) A LA VEZ que se añade este
// fichero como recurso manual (/local/...) para probar cambios sin publicar antes una release
// nueva, el navegador carga AMBOS scripts - sin esta guarda, el segundo `customElements.define`
// lanza "has already been used with this registry" y revienta en consola (y, peor, dependiendo
// del orden de carga, el codigo que "gana" podria ser el antiguo de HACS, no el que se esta
// probando). No sustituye a la solucion real (dejar activo solo un recurso a la vez, o publicar
// una release nueva en HACS antes de retirar el resource manual) pero evita el crash y hace
// que quede claro por consola cual copia esta realmente activa.
if (!customElements.get('ig-doorbell-card-editor')) {
  customElements.define('ig-doorbell-card-editor', IgDoorbellCardEditor);
} else {
  console.warn('[ig-doorbell-card] ig-doorbell-card-editor ya estaba registrado (probablemente hay dos recursos de esta card cargados a la vez, p.ej. HACS + /local/) - esta copia del script no se activa');
}

if (!customElements.get('ig-doorbell-card')) {
  customElements.define('ig-doorbell-card', IgDoorbellCard);

  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === 'ig-doorbell-card')) {
    window.customCards.push({
      type: "ig-doorbell-card",
      name: "Islautopia Intercom",
      preview: true,
      description: "Tarjeta de videoportero WebRTC bidireccional optimizada para el ecosistema Islautopia Garage."
    });
  }
} else {
  console.warn('[ig-doorbell-card] ig-doorbell-card ya estaba registrado (probablemente hay dos recursos de esta card cargados a la vez, p.ej. HACS + /local/) - esta copia del script no se activa');
}