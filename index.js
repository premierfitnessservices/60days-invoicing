const puppeteer = require('puppeteer');
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

app.post('/send-emails', async (req, res) => {
  const invoiceUrls = req.body.invoice;

  if (!Array.isArray(invoiceUrls) || invoiceUrls.length === 0) {
    return res.status(400).json({ error: 'No invoice URLs provided' });
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  let result = {};

  try {
    const page = await browser.newPage();

    await page.goto('https://auth.servicefusion.com/auth/login', { waitUntil: 'networkidle2' });
    await page.type('#company', 'pfs21485');
    await page.type('#uid', 'Lui-G');
    await page.type('#pwd', 'Premierlog5335!');
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    const url = invoiceUrls[0];
    try {
      console.log(`📨 Opening invoice: ${url}`);
      await page.goto(url, { waitUntil: 'networkidle2' });

      const jobTotalDue = await page.evaluate(() => {
        const totalCell = document.querySelector('td h4 a[href="#"][data-toggle="modal"]');
        if (totalCell) {
          const match = totalCell.textContent.trim().match(/\$([0-9,.]+)/);
          return match ? parseFloat(match[1].replace(/,/g, '')) : null;
        }
        return null;
      });
      console.log(`💵 Job Total Due: ${jobTotalDue}`);

      let jobNumber, jobUrl;
      const jobInfo = await page.evaluate(() => {
        const jobLink = document.querySelector('a[href^="/jobs/jobView"]');
        if (jobLink) {
          return {
            number: jobLink.textContent.trim(),
            href: jobLink.href
          };
        }
        return null;
      });

      if (jobInfo) {
        jobNumber = jobInfo.number;
        jobUrl = jobInfo.href;
        console.log(`🔢 Job Number: ${jobNumber}`);
        console.log(`🔗 Job URL: ${jobUrl}`);
      } else {
        console.log('⚠️ Job Number not found.');
      }

      let hasLateFee = false;
      if (jobUrl) {
        await page.goto(jobUrl, { waitUntil: 'networkidle2' });

        hasLateFee = await page.evaluate(() => {
          const serviceNames = Array.from(document.querySelectorAll('dl dt')).map(dt => dt.textContent.trim());
          return serviceNames.includes('Late Fee');
        });

        console.log(hasLateFee ? '⚠️ Late Fee detected.' : '✅ No Late Fee, proceed as normal.');

        if (!hasLateFee && jobTotalDue !== null) {
          console.log('🔧 Adding Late Fee...');
          await page.waitForSelector('a.btn[href*="jobEdit"]', { visible: true });
          await Promise.all([
            page.waitForNavigation(),
            page.click('a.btn[href*="jobEdit"]')
          ]);

          await page.waitForSelector('#service-product-search-box', { visible: true });
          await page.type('#service-product-search-box', 'fee');
          await page.waitForSelector('.ui-autocomplete li[li_name="Fee"]', { visible: true });
          await page.evaluate(() => {
            const feeItem = document.querySelector('.ui-autocomplete li[li_name="Fee"]');
            if (feeItem) feeItem.click();
          });

          console.log('✅ "Fee" item selected.');
          await new Promise(resolve => setTimeout(resolve, 2000));

          const feeRowId = await page.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('input[name*="[unitPrice]"]'));
            for (let input of inputs) {
              const name = input.getAttribute('name');
              const id = input.id;
              if (name && name.includes('[4375394]')) {
                const match = id?.match(/unit-price-services-(\d+)/);
                if (match) return match[1];
              }
            }
            return null;
          });

          if (feeRowId !== null) {
            const lateFee = (jobTotalDue * 0.10).toFixed(2);
            const qtySelector = `#spinner-decimal-${feeRowId}`;
            const rateSelector = `#unit-price-services-${feeRowId}`;
            const nameSelector = `#short-text-services-${feeRowId}`;

            await page.evaluate((qtySel) => {
              const input = document.querySelector(qtySel);
              if (input) {
                input.value = '1';
                input.setAttribute('aria-valuenow', '1');
              }
            }, qtySelector);
            console.log('🔢 Quantity set to 1');

            await page.evaluate((rateSel, fee) => {
              const input = document.querySelector(rateSel);
              if (input) {
                input.value = fee;
              }
            }, rateSelector, lateFee);
            console.log(`💰 Set Late Fee = 10% of Job Total Due = ${lateFee}`);

            // ✍️ Rename "Fee" to "Late Fee"
            await page.evaluate((nameSel) => {
              const input = document.querySelector(nameSel);
              if (input) input.value = 'Late Fee';
            }, nameSelector);
            console.log('✏️ Renamed "Fee" to "Late Fee"');

            // 💾 Click Save Job
            await page.click('#createjob');
            console.log('💾 Clicked Save Job');

            // 🧾 Handle modal if it appears
            try {
              await page.waitForSelector('button.jquery-msgbox-button-submit', { timeout: 3000 });
              const modalButtons = await page.$$('button.jquery-msgbox-button-submit');
              for (const btn of modalButtons) {
                const text = await page.evaluate(el => el.textContent.trim(), btn);
                if (text === 'Only This Job') {
                  await btn.click();
                  console.log('➡️ Clicked "Only This Job" on modal');
                  break;
                }
              }
            } catch (modalErr) {
              console.log('ℹ️ No modal appeared after save.');
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            console.log('⚠️ Failed to locate Fee row.');
          }

          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        await page.goto(url, { waitUntil: 'networkidle2' });
      }

      await page.waitForSelector('a.btn[onclick^="showEmailInvoice"]', { timeout: 10000 });
      await page.click('a.btn[onclick^="showEmailInvoice"]');
      await page.waitForSelector('#email-modal', { visible: true });

      try {
        await page.waitForSelector('button.dropdown-toggle[data-toggle="dropdown"]', { visible: true });
        await page.click('button.dropdown-toggle[data-toggle="dropdown"]');
        await new Promise(resolve => setTimeout(resolve, 1000));

        const contactClicked = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('ul.customer-other-contacts li:not(.disabled) a'))
            .filter(a => a.getAttribute('onclick')?.includes('setemails'));
          if (links.length > 0) {
            links[0].click();
            return true;
          }
          return false;
        });

        console.log(contactClicked ? '✅ Selected Other Contact.' : 'ℹ️ No Other Contact.');
      } catch {
        console.log('ℹ️ Other Contact dropdown not available.');
      }

      const contactEmails = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('ul.select2-choices li.select2-search-choice div'))
          .map(div => div.textContent.trim());
      });

      const templateName = '61 Days Past Due';
      await page.waitForSelector('#s2id_customForms .select2-choice', { visible: true });
      await page.click('#s2id_customForms .select2-choice');
      await page.waitForSelector('.select2-drop-active .select2-search input', { visible: true });
      await page.type('.select2-drop-active .select2-search input', templateName);
      await page.keyboard.press('Enter');
      console.log(`✅ Selected template: ${templateName}`);

      await new Promise(resolve => setTimeout(resolve, 2000));
      await page.waitForSelector('#btn-load-then-complete', { visible: true });
      await page.click('#btn-load-then-complete');
      await new Promise(resolve => setTimeout(resolve, 2000));
      console.log('✅ Email sent.');

      result = {
        success: true,
        sent: 1,
        invoice: url,
        jobNumber: jobNumber || 'Not Found'
      };

      contactEmails.forEach((email, i) => {
        result[`contact_${i + 1}`] = email;
        console.log(`📬 contact_${i + 1}: ${email}`);
      });

    } catch (err) {
      console.error(`❌ Failed on invoice ${url}:`, err.message);
      result = {
        success: false,
        invoice: url,
        error: err.message
      };
    }

    await browser.close();
    return res.json(result);

  } catch (err) {
    await browser.close();
    return res.status(500).json({ success: false, error: 'Automation failed', details: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running at http://localhost:${PORT}/send-emails`);
});
