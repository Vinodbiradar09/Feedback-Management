# 📋 Feedback Management System

The **Feedback Management System** is a role-based application designed to simplify and streamline the process of collecting and managing employee feedback within an organization. It supports employees, managers, and admins with powerful features including bulk feedback, edit history tracking, dashboard analytics, and PDF export functionality.

---

## 🚀 Features

- 🔐 **Role-Based Access** (Admin, Manager, Employee)
- 📥 **Bulk Feedback Submission** by Managers
- 🧠 **Feedback Edit History Tracking**
- 📊 **Manager Dashboard** with analytics:
  - Active employee count
  - Recently active users
  - Feedback activity trends
- 📤 **Export Feedback as PDF** via Email (Employee & Manager)
- ⚙️ **Atomic Employee Transfers** between teams
- 🧰 **Optimized MongoDB Aggregation Pipelines**
- ⚡ **Dashboard Caching** for high performance

---

## 🛠️ Tech Stack

| Layer       | Tech Used                     |
|-------------|-------------------------------|
| Backend     | Node.js, Express.js           |
| Database    | MongoDB (Aggregations, Txns)  |
| Email       | Nodemailer                    |
| PDF Export  | PDFKit                        |
| Caching     | Node-Cache                    |
| Auth        | Custom middleware (role-based)|

---

## 📁 Project Structure

src/
│
├── controllers/ # Route controller logic
├── models/ # Mongoose schemas
├── routes/ # Express route handlers
├── utils/ # Helper utilities (error, response, etc.)
├── middlewares/ # Auth & error handling middleware
├── config/ # DB config and constants
├── services/ # Service-level logic for exports/emails
└── index.js # App entry point

---

## 🧪 Environment Variables

Create a `.env` file in the root directory and add the following:

```env
PORT=4001
MONGO_URI=your_mongodb_uri
JWT_SECRET=your_secret
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=your_email@example.com
SMTP_PASS=your_email_password
EMAIL_FROM=no-reply@example.com

# Clone the repo
git clone https://github.com/your-username/feedback-management.git
cd feedback-management

# Install dependencies
npm install

# Start the server
npm run dev
