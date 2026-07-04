# Mera Chat Room 💬

Real-time multi-room chat app (Node.js + Socket.io) jisme ek permanent Owner account, user login/register, aur moderation tools (kick/ban) hain.

## Features
- Multiple chat rooms
- Real-time messaging, online users list, typing indicator, message history
- **Permanent Owner account** — .env file mein set karein, isi username/password se **kisi bhi device se** login karke aap hamesha Owner rahenge
- **User accounts**: log in / register with password, ya Guest ke taur par bina account ke join karein
- **🎨 Naam aur message ka style**: har user apne naam ka color/bold aur apne message ke text ka color/bold khud choose kar sakta hai — "🎨 Naam/Message Style" button se. Registered users ke liye ye style hamesha save rehti hai (agli baar login par bhi wahi dikhegi); guests ke liye us browser mein save rehti hai.
- **💬 Private Messages (Inbox)**:
  - Right sidebar mein "Online Users" ki live list — koi bhi online user par click karke unki profile card dekhein (naam, role, aur unki set ki hui **city**)
  - Kisi ko private message bhejne ke liye pehle unhein ek **request** jati hai — jab tak wo accept na karein, private chat khulti nahi
  - Ek baar accept hone ke baad "📥 Inbox" mein wo conversation hamesha ke liye save rehti hai
  - Apni city set karne ke liye "📍 Meri City Set Karein" button (sirf city ka naam, exact location nahi)
  - **Private messages sirf dono participants dekh sakte hain — koi third user nahi.** Sirf **Owner** ko "🕵️ Sab Private Messages Dekhein" ka special access hai jahan wo koi bhi conversation padh sakta hai (moderation/oversight ke liye)
  - **Owner bypass**: Owner kisi ko bhi bina request bheje seedha private message kar sakta hai — conversation turant khul jati hai
- **Owner Tools:**
  - Kisi bhi registered user ko **Admin** banayein ya hataein
  - Kisi user ka **password reset** karein (temporary password milta hai jo aap unhein bata sakte hain; agli baar login par unse naya password set karwaya jayega)
  - **Timed Kick**: user ko X minute ke liye nikal dein — waqt guzarne ke baad wo khud dobara join kar sakta hai, kisi manual unban ki zaroorat nahi
  - **Ban**: user ko permanently block karein — unka username, network (IP), device fingerprint, aur device ID — chaaron block ho jate hain, jab tak aap khud unban na karein
  - Banned list dekhna aur unban karna

## Setup

1. Node.js install karein: https://nodejs.org
2. Terminal mein:
   ```
   cd chatroom
   npm install
   ```
3. `.env` file kholein aur apna owner username/password set karein:
   ```
   OWNER_USERNAME=owner
   OWNER_PASSWORD=aik_mazboot_password
   ```
   **Ye zaroor badlein** — default password sab ko pata hai.
4. Server chalayein:
   ```
   npm start
   ```
5. Browser mein `http://localhost:3000` kholein.

Pehli baar server chalate hi ek Owner account apne aap ban jata hai (.env ke username/password se). Ab aap kisi bhi device/browser se **Login** tab mein wahi username/password daal kar hamesha Owner ke taur par aa sakte hain.

## Roles kaise kaam karte hain

| Role | Kya kar sakta hai |
|---|---|
| **Owner** (aap) | Sab kuch — admin banana/hatana, kick, ban/unban, password reset. Owner ko koi kick/ban nahi kar sakta. |
| **Admin** | Members ko kick kar sakta hai. Ban/promote/demote nahi kar sakta. |
| **Member** (registered) | Normal chat. Register kiya hua account, dobara login ho sakta hai. |
| **Guest** | Bina account ke, sirf naam se join. Kick/ban ho sakta hai lekin admin nahi banaya ja sakta (iske liye register karna hoga). |

## Kick vs Ban — farq

- **Kick** = temporary. Aap minutes set karte hain (e.g. 10, 60, 1440 for a day). Time poora hote hi wo user khud dobara login/join kar sakta hai — kisi action ki zaroorat nahi.
- **Ban** = permanent, jab tak aap khud unban na karein. Ban char cheezon ko block karta hai:
  - Us **username** ko (chahe wo registered ho ya guest)
  - Us waqt ke connection ki **IP/network** ko
  - Us device ka **canvas/browser fingerprint** (GPU, fonts, screen jaisi cheezon se banta hai — VPN se change nahi hota)
  - Us browser mein chupa hua **persistent device ID** (agar wahi browser dobara use kiya to, chahe naya account banaye, pakड़ा jayega)

⚠️ **Ek zaroori sachai:** Koi bhi website (Facebook, Discord, YouTube waghera bhi) kisi determined user ko 100% rokne ki guarantee nahi de sakti. Agar koi VPN **aur** bilkul naya browser/device **aur** apna data clear kar ke aaye, to IP-ban aur device-ID bypass ho sakte hain. Lekin canvas fingerprint kaafi had tak GPU/OS-level hoti hai, isliye sirf browser badalne ya VPN lagane se akele wo bypass nahi hoti — dono cheezein sath karni parti hain. Ye 4 layers milkar casual ban-evasion ko bohot mushkil bana dete hain, jo zyada tar log try karte hain.

Owner "Owner Tools → Banned List" mein dekh sakta hai kis username/IP/fingerprint/device par ban laga hai, aur ek click se unban kar sakta hai.

## Deploy karne ke liye (Render/Railway/Glitch)
1. Is folder ko GitHub repo mein daal dein (`.env` file **commit na karein** — `.gitignore` mein already excluded hai)
2. Hosting platform par environment variables mein `OWNER_USERNAME` aur `OWNER_PASSWORD` set karein
3. Build command: `npm install` — Start command: `npm start`
4. Deploy karein, public URL mil jayega

## Zaroori note: data storage aur safety
User accounts, bans, kicks, aur **private messages** — sab ek simple `data.json` file mein save hote hain (server ke folder mein). Ye ab pehle se zyada mehfooz hai:
- Har save **turant, synchronously** hoti hai — koi delay/debounce nahi, taake register/login/ban jaisi cheez server crash hone se pehle bhi disk par likhi ja chuki ho
- Har save se pehle purani file ki `data.backup.json` copy ban jati hai
- Agar `data.json` kisi wajah se corrupt ho jaye ya missing ho, server automatically `data.backup.json` se recover kar leta hai — sirf tab naya/khali data banaya jata hai jab dono files na milein
- Isliye normal restart, crash, ya update par aapke registered users ka data **delete nahi hota** — wo apne username/password se hamesha dobara login kar sakte hain

⚠️ Ek exception: agar aap **free hosting** (jaise Render free tier) use kar rahe hain jahan filesystem har naye deploy par pura reset ho jata hai, to `data.json` bhi us waqt reset ho ga — ye hosting platform ka behavior hai, code ka masla nahi. Agar aapko permanent hosting chahiye jahan ye kabhi na ho, to database service (jaise MongoDB Atlas free tier, jo alag se hosted hota hai) add karna behtar hoga — bata dein agar chahiye.

## Aage kya add ho sakta hai
- Private/1-on-1 messaging
- Emoji picker, file/image sharing
- Password-protected rooms
- Message delete/edit
- Proper database (MongoDB) taake data kabhi na khoye
- Email-based password reset (bina owner ke)
