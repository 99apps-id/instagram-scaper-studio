import ExcelJS from 'exceljs';

export async function exportInstagramLeadsToExcel(leads, outputPath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Insta Scraper Studio (99apps.id)';
  wb.created = new Date();

  const ws = wb.addWorksheet('Instagram Leads & Analytics', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });

  ws.columns = [
    { header: 'No', key: 'no', width: 6 },
    { header: 'Username', key: 'username', width: 20 },
    { header: 'Nama Bisnis / Profil', key: 'fullName', width: 28 },
    { header: 'Kategori', key: 'category', width: 22 },
    { header: 'WhatsApp / Telepon', key: 'phone', width: 20 },
    { header: 'Email Bisnis', key: 'email', width: 26 },
    { header: 'Followers', key: 'followerCount', width: 14 },
    { header: 'Following', key: 'followingCount', width: 14 },
    { header: 'Total Post', key: 'totalPosts', width: 12 },
    { header: 'Engagement Rate (%)', key: 'engagementRate', width: 20 },
    { header: 'Rata-rata Likes', key: 'avgLikes', width: 16 },
    { header: 'Rata-rata Komentar', key: 'avgComments', width: 18 },
    { header: 'Top Hashtags', key: 'topHashtags', width: 28 },
    { header: 'Bio Lengkap', key: 'biography', width: 35 },
    { header: 'Website / Link Bio', key: 'externalUrl', width: 26 },
    { header: 'URL Profil', key: 'profileUrl', width: 32 }
  ];

  // Header styling: Gradient Blue/Purple Instagram theme
  const headerRow = ws.getRow(1);
  headerRow.height = 28;
  headerRow.eachCell((cell) => {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4F46E5' } // Indigo 600
    };
    cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  leads.forEach((item, idx) => {
    const row = ws.addRow({
      no: idx + 1,
      username: item.username ? `@${item.username}` : '-',
      fullName: item.fullName || '-',
      category: item.category || 'Bisnis',
      phone: item.phone || '-',
      email: item.email || '-',
      followerCount: item.followerCount || 0,
      followingCount: item.followingCount || 0,
      totalPosts: item.totalPosts || 0,
      engagementRate: item.engagementRate ? `${item.engagementRate}%` : '0%',
      avgLikes: item.avgLikes || 0,
      avgComments: item.avgComments || 0,
      topHashtags: Array.isArray(item.topHashtags) ? item.topHashtags.join(', ') : '-',
      biography: item.biography || '-',
      externalUrl: item.externalUrl || '-',
      profileUrl: item.profileUrl || `https://www.instagram.com/${item.username}/`
    });

    row.height = 22;
    row.eachCell((cell, colNumber) => {
      cell.font = { name: 'Segoe UI', size: 9 };
      cell.alignment = { vertical: 'middle', horizontal: [1, 5, 7, 8, 9, 10, 11, 12].includes(colNumber) ? 'center' : 'left' };
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } }
      };
    });
  });

  await wb.xlsx.writeFile(outputPath);
  return outputPath;
}
