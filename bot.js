require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags,
} = require('discord.js');
const fs = require('fs');

// ตั้งค่าทั้งหมดดึงจาก .env ไม่มีอะไร hardcode
const config = {
  discordToken:     process.env.DISCORD_TOKEN,
  sellauthKey:      process.env.SELLAUTH_API_KEY,
  shopId:           process.env.SELLAUTH_SHOP_ID,
  reviewChannelId:  process.env.REVIEW_CHANNEL_ID,
  guildId:          process.env.GUILD_ID,
  githubToken:      process.env.GITHUB_TOKEN,
  githubUsername:   process.env.GITHUB_USERNAME,
  githubRepo:       process.env.GITHUB_REPO,
  githubFilePath:   'reviews.json',
  couponDiscount:   10,
  couponMaxUses:    1,
  sellauthBase:     'https://api.sellauth.com/v1',
};

// เก็บ session ของแต่ละคนที่กำลังรีวิวอยู่
const sessions = new Map();

// ─── ฐานข้อมูล order ที่ใช้ไปแล้ว ───────────────────────────────────────────

const DB_FILE = './reviews_db.json';

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ usedOrderIds: [] }));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ─── รีวิวที่เก็บไว้ในเครื่อง ─────────────────────────────────────────────

const REVIEWS_FILE = './reviews.json';

function loadReviews() {
  if (!fs.existsSync(REVIEWS_FILE)) {
    fs.writeFileSync(REVIEWS_FILE, JSON.stringify([]));
  }
  try {
    return JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function addReview(review) {
  const all = loadReviews();
  all.unshift(review); // ใหม่ก่อนเสมอ
  fs.writeFileSync(REVIEWS_FILE, JSON.stringify(all, null, 2));
  return all;
}

// ─── ส่ง reviews.json ขึ้น GitHub ─────────────────────────────────────────

async function pushToGitHub(reviews) {
  const { githubToken, githubUsername, githubRepo, githubFilePath } = config;

  if (!githubToken || !githubUsername || !githubRepo) {
    console.warn('ยังไม่ได้ตั้งค่า GitHub ใน .env — ข้ามการ push');
    return;
  }

  const apiUrl = `https://api.github.com/repos/${githubUsername}/${githubRepo}/contents/${githubFilePath}`;
  const headers = {
    'Authorization': `Bearer ${githubToken}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  // ดึง SHA ของไฟล์เดิมก่อน (ถ้ามี) เพื่อ update แทน create ใหม่
  let sha = null;
  try {
    const check = await fetch(apiUrl, { headers });
    if (check.ok) {
      const data = await check.json();
      sha = data.sha;
    }
  } catch {
    // ไฟล์ยังไม่มี — push ครั้งแรก ไม่ต้องมี sha
  }

  const content = Buffer.from(JSON.stringify(reviews, null, 2)).toString('base64');
  const body = JSON.stringify({
    message: `อัปเดตรีวิว ${new Date().toISOString()}`,
    content,
    ...(sha ? { sha } : {}),
  });

  try {
    const res = await fetch(apiUrl, { method: 'PUT', headers, body });
    if (res.ok) {
      console.log('✅ push reviews.json ขึ้น GitHub สำเร็จ');
    } else {
      console.error('❌ GitHub push ล้มเหลว:', await res.text());
    }
  } catch (err) {
    console.error('❌ GitHub push error:', err);
  }
}

// ─── SellAuth helpers ──────────────────────────────────────────────────────

function sellauthHeaders() {
  return {
    'Authorization': `Bearer ${config.sellauthKey}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

async function verifyInvoice(orderId) {
  // test key สำหรับทดสอบ ข้ามการเช็คจริง
  if (orderId === 'test123key') {
    return { id: 'test123key', status: 'completed' };
  }

  try {
    const res = await fetch(
      `${config.sellauthBase}/shops/${config.shopId}/invoices/${orderId}`,
      { headers: sellauthHeaders() }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.status === 'completed' ? data : null;
  } catch (err) {
    console.error('verifyInvoice error:', err);
    return null;
  }
}

async function createCoupon(discordId) {
  // สร้างโค้ดไม่ซ้ำกัน
  const code = 'REVIEW-' + discordId.slice(-5) + '-' + Math.random().toString(36).substring(2, 7).toUpperCase();

  const body = JSON.stringify({
    code,
    global: true,
    discount: config.couponDiscount,
    type: 'percentage',
    max_uses: config.couponMaxUses,
    max_uses_per_customer: 1,
    disable_if_volume_discount: false,
  });

  try {
    const res = await fetch(
      `${config.sellauthBase}/shops/${config.shopId}/coupons`,
      { method: 'POST', headers: sellauthHeaders(), body }
    );
    const text = await res.text();
    console.log(`Coupon API [${res.status}]:`, text);
    if (!res.ok) return null;
    const data = JSON.parse(text);
    return data.code || code;
  } catch (err) {
    console.error('createCoupon error:', err);
    return null;
  }
}

// ─── Discord client ────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', async () => {
  console.log(`🤖 บอทออนไลน์: ${client.user.tag}`);

  await client.application.commands.create(
    new SlashCommandBuilder()
      .setName('review')
      .setDescription('รีวิวสินค้าและรับคูปองส่วนลด 10%!')
      .toJSON()
  );
  console.log('✅ ลงทะเบียนคำสั่ง /review แล้ว');
});

// ─── จัดการ interaction ทั้งหมด ───────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {

  // คำสั่ง /review
  if (interaction.isChatInputCommand() && interaction.commandName === 'review') {
    await interaction.reply({
      content: '📩 เช็ค DM ได้เลย! ส่งข้อความไปหาคุณแล้ว',
      flags: MessageFlags.Ephemeral,
    });
    await startReviewFlow(interaction.user);
    return;
  }

  // เลือกคะแนนดาว
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_rating') {
    const session = sessions.get(interaction.user.id);
    if (!session) {
      await interaction.reply({ content: '⏰ Session หมดอายุแล้ว ใช้ /review ใหม่อีกครั้ง', flags: MessageFlags.Ephemeral });
      return;
    }

    session.rating = parseInt(interaction.values[0]);
    sessions.set(interaction.user.id, session);

    // เปิด modal ให้เขียนรีวิว
    const modal = new ModalBuilder()
      .setCustomId('review_modal')
      .setTitle('✍️ เขียนรีวิวของคุณ');

    const textInput = new TextInputBuilder()
      .setCustomId('review_text')
      .setLabel('คุณคิดยังไงกับสินค้าที่ซื้อ?')
      .setStyle(TextInputStyle.Paragraph)
      .setMinLength(10)
      .setMaxLength(500)
      .setPlaceholder('เล่าประสบการณ์ของคุณ...')
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(textInput));
    await interaction.showModal(modal);
    return;
  }

  // ส่งรีวิวแล้ว
  if (interaction.isModalSubmit() && interaction.customId === 'review_modal') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const session = sessions.get(interaction.user.id);
    if (!session) {
      await interaction.editReply('⏰ Session หมดอายุแล้ว ใช้ /review ใหม่อีกครั้ง');
      return;
    }

    const reviewText = interaction.fields.getTextInputValue('review_text');
    const starsDisplay = '⭐'.repeat(session.rating) + '☆'.repeat(5 - session.rating);

    // โพสรีวิวในช่อง Discord
    const reviewChannel = await client.channels.fetch(config.reviewChannelId);
    const embed = new EmbedBuilder()
      .setColor(0xf5a623)
      .setTitle('⭐ รีวิวใหม่')
      .setDescription(`> ${reviewText}`)
      .addFields(
        { name: 'คะแนน', value: starsDisplay, inline: true },
        { name: 'จาก', value: `<@${interaction.user.id}>`, inline: true }
      )
      .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
      .setTimestamp()
      .setFooter({ text: 'ระบบรีวิว SellAuth' });

    await reviewChannel.send({ embeds: [embed] });

    // บันทึกรีวิวและ push ขึ้น GitHub
    const avatarURL = interaction.user.displayAvatarURL({ dynamic: false, size: 128, format: 'png' });
    const updated = addReview({
      id: Date.now(),
      rating: session.rating,
      text: reviewText,
      date: new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' }),
      avatar: avatarURL,
    });
    pushToGitHub(updated); // ไม่รอ — ทำ background

    // บันทึก orderId ว่าใช้ไปแล้ว
    if (session.orderId !== 'test123key') {
      const db = loadDB();
      if (!db.usedOrderIds) db.usedOrderIds = [];
      db.usedOrderIds.push(session.orderId);
      saveDB(db);
    }
    sessions.delete(interaction.user.id);

    // สร้างคูปอง
    const couponCode = await createCoupon(interaction.user.id);
    if (!couponCode) {
      await interaction.editReply('✅ โพสรีวิวแล้ว! แต่มีปัญหาสร้างคูปอง — กรุณาติดต่อ support');
      return;
    }

    // DM คูปองให้ลูกค้า
    const couponEmbed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🎉 ขอบคุณสำหรับรีวิว!')
      .setDescription('นี่คือโค้ดส่วนลด **10%** ของคุณ!')
      .addFields(
        { name: '🏷️ โค้ดคูปอง', value: '```' + couponCode + '```' },
        { name: 'รายละเอียด', value: '• ลด 10% สำหรับออเดอร์ถัดไป\n• ใช้ได้ครั้งเดียวเท่านั้น\n• ใช้ได้กับสินค้าทุกชนิด' }
      )
      .setTimestamp();

    try {
      const dm = await interaction.user.createDM();
      await dm.send({ embeds: [couponEmbed] });
      await interaction.editReply('✅ โพสรีวิวแล้ว! เช็ค DM เพื่อรับโค้ดคูปองของคุณ');
    } catch {
      // DM ปิดอยู่ ส่งโค้ดใน reply แทน
      await interaction.editReply(`✅ โพสรีวิวแล้ว! โค้ดของคุณ: \`${couponCode}\` (ลด 10% ใช้ได้ครั้งเดียว)`);
    }
  }
});

// ─── ขั้นตอนรีวิวใน DM ────────────────────────────────────────────────────

async function startReviewFlow(user) {
  try {
    const dm = await user.createDM();

    await dm.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle('📝 เขียนรีวิว')
          .setDescription('กรุณาส่ง **Order ID** ของคุณมาเลย\n\nหา Order ID ได้จากอีเมลยืนยันการซื้อ')
          .setFooter({ text: 'คุณมีเวลา 5 นาทีในการทำรายการ' }),
      ],
    });

    // รอรับ Order ID จาก DM
    const collector = dm.createMessageCollector({
      filter: (m) => m.author.id === user.id && m.channel.type === 1,
      time: 300_000, // 5 นาที
      max: 5,
    });

    collector.on('collect', async (msg) => {
      const orderId = msg.content.trim();

      // เช็คว่า order นี้เคยใช้ไปแล้วหรือยัง
      if (orderId !== 'test123key') {
        const db = loadDB();
        if ((db.usedOrderIds || []).includes(orderId)) {
          await dm.send('❌ Order ID นี้ถูกใช้รีวิวไปแล้ว แต่ละออเดอร์ได้คูปองแค่ครั้งเดียว');
          collector.stop('duplicate');
          return;
        }
      }

      // ยืนยัน invoice กับ SellAuth
      const invoice = await verifyInvoice(orderId);
      if (!invoice) {
        await dm.send('❌ ไม่พบ Order ID นี้ ตรวจสอบให้แน่ใจว่าถูกต้องและออเดอร์ชำระเงินแล้ว แล้วลองใหม่อีกครั้ง');
        return;
      }

      sessions.set(user.id, { orderId, invoice });
      collector.stop('found');

      // ให้เลือกคะแนนดาว
      const ratingMenu = new StringSelectMenuBuilder()
        .setCustomId('select_rating')
        .setPlaceholder('เลือกคะแนน...')
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel('1 ดาว — แย่').setValue('1').setEmoji('1️⃣'),
          new StringSelectMenuOptionBuilder().setLabel('2 ดาว — พอใช้').setValue('2').setEmoji('2️⃣'),
          new StringSelectMenuOptionBuilder().setLabel('3 ดาว — ดี').setValue('3').setEmoji('3️⃣'),
          new StringSelectMenuOptionBuilder().setLabel('4 ดาว — ดีมาก').setValue('4').setEmoji('4️⃣'),
          new StringSelectMenuOptionBuilder().setLabel('5 ดาว — ยอดเยี่ยม').setValue('5').setEmoji('5️⃣')
        );

      await dm.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('⭐ ให้คะแนนประสบการณ์')
            .setDescription('คุณพอใจกับสินค้าที่ซื้อมากแค่ไหน?'),
        ],
        components: [new ActionRowBuilder().addComponents(ratingMenu)],
      });
    });

    collector.on('end', async (_, reason) => {
      if (reason === 'time') {
        await dm.send('⏰ หมดเวลาแล้ว ใช้ /review อีกครั้งเพื่อเริ่มใหม่');
        sessions.delete(user.id);
      }
    });

  } catch (err) {
    console.error('DM flow error:', err);
  }
}

client.login(config.discordToken);
