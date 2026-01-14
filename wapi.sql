-- phpMyAdmin SQL Dump
-- version 5.2.2
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1:3306
-- Generation Time: Nov 05, 2025 at 02:33 PM
-- Server version: 8.0.43
-- PHP Version: 8.1.33

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `jasaedukasi-wapi`
--

-- --------------------------------------------------------

--
-- Table structure for table `admin`
--

DROP TABLE IF EXISTS `admin`;
CREATE TABLE `admin` (
  `uid` int NOT NULL,
  `name` varchar(60) DEFAULT NULL,
  `email` varchar(80) DEFAULT NULL,
  `phone` varchar(30) DEFAULT NULL,
  `username` varchar(60) DEFAULT NULL,
  `password` varchar(255) DEFAULT NULL,
  `api_key` varchar(255) NOT NULL,
  `active` int DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `admin`
--

INSERT INTO `admin` (`uid`, `name`, `email`, `phone`, `username`, `password`, `api_key`, `active`, `created_at`) VALUES
(1, 'Administrator', 'admin@mail.com', '6285769641780', 'admin', '1234', '', 1, '2025-06-08 02:46:33');

-- --------------------------------------------------------

--
-- Table structure for table `autoreply`
--

DROP TABLE IF EXISTS `autoreply`;
CREATE TABLE `autoreply` (
  `id` int NOT NULL,
  `uid` int NOT NULL,
  `device_id` int NOT NULL,
  `keyword` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `response` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `status` enum('active','inactive') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `used` int DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `is_for_personal` tinyint(1) DEFAULT '1',
  `is_for_group` tinyint(1) DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `autoreply`
--

INSERT INTO `autoreply` (`id`, `uid`, `device_id`, `keyword`, `response`, `status`, `used`, `created_at`, `updated_at`, `is_for_personal`, `is_for_group`) VALUES
(6, 3, 5, 'test', 'Halo ini adalah AutoReply testing', 'active', NULL, '2025-06-09 12:41:44', '2025-06-09 12:41:44', 1, 1),
(9, 3, 5, 'hallo', 'Waalaikumsalam 🙏, selamat datang di layanan informasi sekolah. Ketik menu untuk melihat daftar layanan.', 'active', NULL, '2025-09-17 04:41:44', '2025-09-17 04:41:44', 1, 1),
(10, 3, 5, 'assallamuallaikum', 'Waalaikumsalam 🙏, selamat datang di layanan informasi sekolah. Ketik menu untuk melihat daftar layanan.', 'active', NULL, '2025-09-17 04:41:51', '2025-09-17 04:41:51', 1, 1),
(11, 3, 5, 'menu', '📚 Layanan Informasi Sekolah:\n1️⃣ Jadwal\n2️⃣ Pendaftaran\n3️⃣ Biaya\n4️⃣ Kontak Guru\n5️⃣ Alamat', 'active', NULL, '2025-09-17 04:42:22', '2025-09-17 04:42:22', 1, 1),
(12, 3, 5, 'jadwal', '🗓️ Jadwal kegiatan sekolah:\n- Senin–Jumat: Kegiatan Belajar Mengajar\n- Sabtu: Ekstrakurikuler\n- Minggu: Libur', 'active', NULL, '2025-09-17 04:42:39', '2025-09-17 04:42:39', 1, 1),
(14, 3, 5, 'biaya', '💳 Informasi Biaya Sekolah:\n- SPP: Rp 0/bulan\n- Seragam: Disesuaikan\n- Buku: Sesuai kebutuhan semester', 'active', NULL, '2025-09-17 04:43:49', '2025-09-17 04:43:49', 1, 1),
(15, 3, 5, 'kontak', '📞 Kontak Guru/Wali Kelas:\n- Kelas X: Bu Ani (08xxxx)\n- Kelas XI: Pak Budi (08xxxx)\n- Kelas XII: Bu Siti (08xxxx)', 'active', NULL, '2025-09-17 04:44:09', '2025-09-17 04:44:09', 1, 1),
(17, 3, 5, 'info', 'ℹ️ Untuk informasi lebih lanjut, silakan kunjungi website sekolah: https://smkn1margasekampung.sch.id/', 'active', NULL, '2025-09-17 04:44:45', '2025-09-17 04:44:45', 1, 1),
(18, 3, 5, 'alamat', '🏫 Alamat Sekolah:\nPeniangan,Kec. Marga Sekapung, Kabupaten Lampung Timur, Lampung\n📍 Google Maps: https://maps.app.goo.gl/3UUs2XrKKiFYE3gp8', 'active', NULL, '2025-09-17 04:45:50', '2025-09-17 04:45:50', 1, 1),
(19, 3, 5, 'pendaftaran', '📝 Informasi Pendaftaran:\n- Online: https://daftar.smkn1margasekampung.sch.id/\n- Offline: Datang ke Tata Usaha jam 08.00–14.00 WIB\n📞 Hubungi: 08xxxxxxx', 'active', NULL, '2025-09-17 04:47:20', '2025-09-17 04:47:20', 1, 1);

-- --------------------------------------------------------

--
-- Table structure for table `balances`
--

DROP TABLE IF EXISTS `balances`;
CREATE TABLE `balances` (
  `uid` int NOT NULL,
  `balance` decimal(10,2) NOT NULL DEFAULT '0.00',
  `total_used` decimal(10,2) NOT NULL DEFAULT '0.00',
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `balances`
--

INSERT INTO `balances` (`uid`, `balance`, `total_used`, `updated_at`) VALUES
(3, 0.00, 0.00, '2025-02-10 23:15:58'),
(5, 0.00, 0.00, '2025-06-01 14:55:10');

-- --------------------------------------------------------

--
-- Table structure for table `devices`
--

DROP TABLE IF EXISTS `devices`;
CREATE TABLE `devices` (
  `id` int NOT NULL,
  `uid` int NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `phone` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `status` enum('connecting','connected','disconnected','removed','error','logout') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT 'connecting',
  `life_time` int NOT NULL,
  `last_life_decrement` date NOT NULL,
  `limit` int NOT NULL,
  `limit_daily` int NOT NULL DEFAULT '250',
  `last_limit_decrement` date NOT NULL,
  `device_key` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `packageId` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `devices`
--

INSERT INTO `devices` (`id`, `uid`, `name`, `phone`, `status`, `life_time`, `last_life_decrement`, `limit`, `limit_daily`, `last_limit_decrement`, `device_key`, `packageId`, `created_at`, `updated_at`) VALUES
(5, 3, 'Presensi Edukasi', '6285179973381', 'disconnected', 293, '2025-11-03', 0, 1500, '0000-00-00', 'c6b6cc17', '3', '2025-01-31 23:16:58', '2025-11-03 13:54:22'),
(13, 5, 'Presensi Edukasi', '6285179973381', 'disconnected', 304, '2025-11-03', 0, 800, '0000-00-00', '678b1aa4', '3', '2025-01-31 23:16:58', '2025-11-05 12:45:46'),
(15, 6, 'Presensi Edukasi', '6285179973381', 'disconnected', 310, '2025-10-20', 0, 800, '0000-00-00', 'c49e7d2a', '3', '2025-01-31 23:16:58', '2025-10-28 07:12:46');

-- --------------------------------------------------------

--
-- Table structure for table `groups`
--

DROP TABLE IF EXISTS `groups`;
CREATE TABLE `groups` (
  `id` int NOT NULL,
  `group_id` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `group_key` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `device_key` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `registered_at` datetime NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `groups`
--

INSERT INTO `groups` (`id`, `group_id`, `group_key`, `name`, `device_key`, `registered_at`) VALUES
(1, '120363298490204179@g.us', '2ZCP46', 'Presensi Guru SMKN 1 Marse', 'c6b6cc17', '2025-06-09 13:08:17'),
(2, '120363420987301540@g.us', '0VN47N', 'Presensi SMK Muhima', '678b1aa4', '2025-07-05 03:24:38'),
(3, '120363421998339356@g.us', 'TWXMPL', 'Presensi SMK Muhima', '678b1aa4', '2025-09-20 07:25:57'),
(4, '120363420824726021@g.us', 'HXY590', 'Presensi Guru Muhima', 'c6b6cc17', '2025-09-23 08:55:32'),
(5, '120363420824726021@g.us', 'KU6LJC', 'Presensi Guru Muhima', '678b1aa4', '2025-09-23 08:55:33'),
(6, '120363421554981796@g.us', 'IEVZYU', 'Presensi SMP2PGRI BS', 'c6b6cc17', '2025-10-14 22:23:45'),
(7, '120363421554981796@g.us', 'OZWMGR', 'Presensi SMP2PGRI BS', 'c49e7d2a', '2025-10-14 22:23:46'),
(8, '120363421554981796@g.us', 'G24BZE', 'Presensi SMP2PGRI BS', '678b1aa4', '2025-10-14 22:23:47');

-- --------------------------------------------------------

--
-- Table structure for table `logs`
--

DROP TABLE IF EXISTS `logs`;
CREATE TABLE `logs` (
  `id` int NOT NULL,
  `uid` int NOT NULL,
  `action` varchar(255) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=latin1;

-- --------------------------------------------------------

--
-- Table structure for table `messages`
--

DROP TABLE IF EXISTS `messages`;
CREATE TABLE `messages` (
  `id` int NOT NULL,
  `uid` int NOT NULL,
  `device_id` int NOT NULL,
  `number` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `message` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `type` enum('personal','bulk','group') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `tags` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `status` enum('pending','sent','failed','processing') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT 'pending',
  `response` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `packages`
--

DROP TABLE IF EXISTS `packages`;
CREATE TABLE `packages` (
  `id` int NOT NULL,
  `name` varchar(50) NOT NULL,
  `price` decimal(10,2) NOT NULL,
  `duration` int NOT NULL,
  `description` text,
  `recomended` int DEFAULT NULL,
  `message_limit` int NOT NULL,
  `active` int NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

--
-- Dumping data for table `packages`
--

INSERT INTO `packages` (`id`, `name`, `price`, `duration`, `description`, `recomended`, `message_limit`, `active`, `created_at`, `updated_at`) VALUES
(1, 'Paket Basic', 25000.00, 30, '✅ 500 pesan/hari<br>\n✅ Kirim personal<br>\n✅ Kirim group<br>\n✅ Pesan text<br>\n❌ Pesan Blast<br>\n❌ Pesan schedule<br>\n❌ Pesan template<br>\n❌ Pesan button<br>\n❌ Pesan attachment<br>\n❌ Autoreply<br>\n❌ Webhook<br>\n✅ API dasar<br>\n✅ Support 8 jam', 0, 500, 1, '2025-02-08 14:11:28', '2025-06-12 15:40:23'),
(2, 'Paket Standard', 50000.00, 30, '✅ 2.000 pesan/hari<br>\r\n✅ Kirim personal<br>\r\n✅ Kirim group<br>\r\n✅ Pesan text<br>\r\n✅ Pesan Blast (100/hari)<br>\r\n✅ Pesan schedule<br>\r\n✅ Pesan attachment<br>\r\n✅ Autoreply dasar<br>\r\n✅ Webhook<br>\r\n✅ API lengkap<br>\r\n✅ Support 12 jam', 1, 2000, 1, '2025-02-08 14:11:28', '2025-06-10 14:51:09'),
(3, 'Paket Tahunan Pro', 600000.00, 365, '✅ 5.000 pesan/hari<br>\r\n✅ Kirim personal<br>\r\n✅ Kirim group<br>\r\n✅ Pesan text<br>\r\n✅ Pesan Blast (500/hari)<br>\r\n✅ Pesan schedule<br>\r\n✅ Pesan attachment<br>\r\n✅ Autoreply canggih<br>\r\n✅ Webhook<br>\r\n✅ API premium<br>\r\n✅ Support 24/7', 0, 5000, 1, '2025-02-08 14:11:28', '2025-06-10 14:51:09'),
(4, 'Paket Tahunan Basic', 300000.00, 365, '✅ 1.000 pesan/hari<br>\r\n✅ Kirim personal<br>\r\n✅ Kirim group<br>\r\n✅ Pesan text<br>\r\n❌ Pesan Blast<br>\r\n❌ Pesan schedule<br>\r\n❌ Pesan attachment<br>\r\n❌ Autoreply<br>\r\n❌ Webhook<br>\r\n✅ API dasar<br>\r\n✅ Support 8 jam', 0, 1000, 1, '2025-02-08 14:11:28', '2025-06-10 14:51:09');

-- --------------------------------------------------------

--
-- Table structure for table `settings`
--

DROP TABLE IF EXISTS `settings`;
CREATE TABLE `settings` (
  `id` int NOT NULL,
  `key_name` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `value` text CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `transactions`
--

DROP TABLE IF EXISTS `transactions`;
CREATE TABLE `transactions` (
  `id` int NOT NULL,
  `uid` int NOT NULL,
  `merchantOrderId` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `paymentUrl` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `reference` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `description` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `amount` decimal(10,2) NOT NULL,
  `status` enum('success','pending','failed','paid') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `whatIs` enum('+','-') CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `transactions`
--

INSERT INTO `transactions` (`id`, `uid`, `merchantOrderId`, `paymentUrl`, `reference`, `description`, `amount`, `status`, `whatIs`, `created_at`, `updated_at`) VALUES
(1, 5, '1749524965584', NULL, 'DS2191125AO8ULA1E72QOR4F', 'Top-Up Saldo', 25000.00, 'pending', '+', '2025-06-10 03:09:25', '2025-06-10 03:09:25'),
(2, 3, '1751199400915', NULL, 'DS2191125CEVSGN4P4REF326', 'Top-Up Saldo', 800000.00, 'pending', '+', '2025-06-29 12:16:43', '2025-06-29 12:16:43'),
(3, 5, '1755423126998', NULL, 'DS2191125BEII500IPKGXE5E', 'Top-Up Saldo', 25000.00, 'pending', '+', '2025-08-17 09:32:07', '2025-08-17 09:32:07');

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
CREATE TABLE `users` (
  `uid` int NOT NULL,
  `name` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `email` varchar(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `phone` varchar(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `username` varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `password` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci DEFAULT NULL,
  `api_key` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL,
  `active` int DEFAULT '0',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `users`
--

INSERT INTO `users` (`uid`, `name`, `email`, `phone`, `username`, `password`, `api_key`, `active`, `created_at`) VALUES
(3, 'SMKN 1 Marga Sekampung', 'smkn1marse@gmail.com', '6285769641780', 'user1', '1234', '9b0a811f5d511d91b630a93ad882064b0ced925ffb46d188df920c339e824e82', 1, '2025-01-31 18:22:28'),
(5, 'SMK MUHAMMADIYAH 1 MARGA TIGA', 'smk1muhima@presensi.edu', '085809024512', NULL, '@12345678', '5016855e26c34715fbbd2d82f2e2b045', 1, '2025-06-01 14:45:16'),
(6, 'SMP PGRI 2 BANDAR SRIBHAWONO', 'smppgri2bs@mail.com', '08580902421', NULL, '@1234', '9f3b2a1c4d5e6f7081a2b3c4d5e6f701', 1, '2025-06-01 14:45:16');

--
-- Indexes for dumped tables
--

--
-- Indexes for table `admin`
--
ALTER TABLE `admin`
  ADD PRIMARY KEY (`uid`);

--
-- Indexes for table `autoreply`
--
ALTER TABLE `autoreply`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `balances`
--
ALTER TABLE `balances`
  ADD PRIMARY KEY (`uid`);

--
-- Indexes for table `devices`
--
ALTER TABLE `devices`
  ADD PRIMARY KEY (`id`),
  ADD KEY `user_id` (`uid`);

--
-- Indexes for table `groups`
--
ALTER TABLE `groups`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `logs`
--
ALTER TABLE `logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `uid` (`uid`);

--
-- Indexes for table `messages`
--
ALTER TABLE `messages`
  ADD PRIMARY KEY (`id`),
  ADD KEY `device_id` (`device_id`);

--
-- Indexes for table `packages`
--
ALTER TABLE `packages`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `settings`
--
ALTER TABLE `settings`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `key_name` (`key_name`);

--
-- Indexes for table `transactions`
--
ALTER TABLE `transactions`
  ADD PRIMARY KEY (`id`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`uid`),
  ADD UNIQUE KEY `api_key` (`api_key`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `admin`
--
ALTER TABLE `admin`
  MODIFY `uid` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=6;

--
-- AUTO_INCREMENT for table `autoreply`
--
ALTER TABLE `autoreply`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=20;

--
-- AUTO_INCREMENT for table `devices`
--
ALTER TABLE `devices`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=16;

--
-- AUTO_INCREMENT for table `groups`
--
ALTER TABLE `groups`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=9;

--
-- AUTO_INCREMENT for table `logs`
--
ALTER TABLE `logs`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `messages`
--
ALTER TABLE `messages`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `packages`
--
ALTER TABLE `packages`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=5;

--
-- AUTO_INCREMENT for table `settings`
--
ALTER TABLE `settings`
  MODIFY `id` int NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `transactions`
--
ALTER TABLE `transactions`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `uid` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=7;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `logs`
--
ALTER TABLE `logs`
  ADD CONSTRAINT `logs_ibfk_1` FOREIGN KEY (`uid`) REFERENCES `users` (`uid`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
