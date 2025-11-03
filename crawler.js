const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_DOMAIN_ATTEMPTS = 10;
const RESULT_DIR = path.join(__dirname, 'result');
const STAT_DIR = path.join(__dirname, 'stat');
const DOMAINS_URL = 'https://github.com/arkadiyt/bounty-targets-data/raw/refs/heads/main/data/domains.txt';
const WILDCARDS_URL = 'https://github.com/arkadiyt/bounty-targets-data/raw/refs/heads/main/data/wildcards.txt';

async function ensureDirectories() {
  await fs.mkdir(RESULT_DIR, { recursive: true });
  await fs.mkdir(STAT_DIR, { recursive: true });
}

async function fetchDomains() {
  const domains = new Set();
  
  try {
    const domainsResponse = await fetch(DOMAINS_URL);
    const domainsText = await domainsResponse.text();
    domainsText.split('\n').forEach(domain => {
      const trimmed = domain.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        domains.add(trimmed);
      }
    });
  } catch (error) {
    console.error('Failed to fetch domains:', error.message);
  }

  try {
    const wildcardsResponse = await fetch(WILDCARDS_URL);
    const wildcardsText = await wildcardsResponse.text();
    wildcardsText.split('\n').forEach(domain => {
      const trimmed = domain.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const cleaned = trimmed.replace(/^\*\./, '');
        if (cleaned) {
          domains.add(cleaned);
        }
      }
    });
  } catch (error) {
    console.error('Failed to fetch wildcards:', error.message);
  }

  return Array.from(domains);
}

async function loadScannedDomains() {
  const statsFile = path.join(STAT_DIR, 'scanned.json');
  try {
    const data = await fs.readFile(statsFile, 'utf8');
    return JSON.parse(data);
  } catch {
    return { scanned: [], lastUpdate: null };
  }
}

async function saveScannedDomains(data) {
  const statsFile = path.join(STAT_DIR, 'scanned.json');
  await fs.writeFile(statsFile, JSON.stringify(data, null, 2));
}

async function getNextResultFile() {
  const files = await fs.readdir(RESULT_DIR).catch(() => []);
  const formFiles = files.filter(f => f.startsWith('forms') && f.endsWith('.json'));
  
  if (formFiles.length === 0) {
    return { path: path.join(RESULT_DIR, 'forms.json'), data: [] };
  }

  formFiles.sort((a, b) => {
    const numA = a.match(/forms(_(\d+))?\.json/);
    const numB = b.match(/forms(_(\d+))?\.json/);
    const indexA = numA && numA[2] ? parseInt(numA[2]) : 0;
    const indexB = numB && numB[2] ? parseInt(numB[2]) : 0;
    return indexB - indexA;
  });

  const lastFile = path.join(RESULT_DIR, formFiles[0]);
  const stats = await fs.stat(lastFile).catch(() => null);
  
  if (stats && stats.size < MAX_FILE_SIZE) {
    const data = JSON.parse(await fs.readFile(lastFile, 'utf8'));
    return { path: lastFile, data };
  }

  const lastIndex = formFiles[0].match(/forms(_(\d+))?\.json/);
  const nextIndex = lastIndex && lastIndex[2] ? parseInt(lastIndex[2]) + 1 : 1;
  return { path: path.join(RESULT_DIR, `forms_${nextIndex}.json`), data: [] };
}

async function saveResults(forms) {
  const { path: filePath, data: existingForms } = await getNextResultFile();
  const allForms = [...existingForms, ...forms];
  await fs.writeFile(filePath, JSON.stringify(allForms, null, 2));
}

function extractFormData(form, url) {
  const formData = {
    url: url,
    action: form.action || '',
    method: form.method || 'get',
    fields: []
  };

  const inputs = form.querySelectorAll('input, textarea, select');
  inputs.forEach(input => {
    const field = {
      type: input.type || input.tagName.toLowerCase(),
      name: input.name || '',
      id: input.id || '',
      placeholder: input.placeholder || '',
      required: input.required || false
    };
    
    if (input.tagName.toLowerCase() === 'select') {
      const options = Array.from(input.querySelectorAll('option')).map(opt => opt.value || opt.textContent);
      field.options = options;
    }
    
    formData.fields.push(field);
  });

  return formData;
}

async function crawlDomain(domain) {
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  
  const page = await context.newPage();
  const forms = [];
  const visited = new Set();
  const toVisit = [];
  
  const baseDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '');
  
  const urls = [
    `https://${domain}`,
    `https://www.${domain}`,
    `http://${domain}`
  ];

  for (const url of urls) {
    if (!visited.has(url)) {
      toVisit.push(url);
    }
  }

  while (toVisit.length > 0 && visited.size < 50) {
    const url = toVisit.shift();
    if (visited.has(url)) continue;
    
    visited.add(url);
    
    try {
      await page.goto(url, { 
        waitUntil: 'domcontentloaded', 
        timeout: 30000 
      });
      
      const pageForms = await page.evaluate((currentUrl) => {
        const forms = Array.from(document.querySelectorAll('form'));
        return forms.map(form => {
          const formData = {
            url: currentUrl,
            action: form.action || '',
            method: form.method || 'get',
            fields: []
          };

          const inputs = form.querySelectorAll('input, textarea, select');
          inputs.forEach(input => {
            const field = {
              type: input.type || input.tagName.toLowerCase(),
              name: input.name || '',
              id: input.id || '',
              placeholder: input.placeholder || '',
              required: input.required || false
            };
            
            if (input.tagName.toLowerCase() === 'select') {
              const options = Array.from(input.querySelectorAll('option')).map(opt => opt.value || opt.textContent);
              field.options = options;
            }
            
            formData.fields.push(field);
          });

          return formData;
        });
      }, url);

      forms.push(...pageForms);

      const links = await page.evaluate((domain) => {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        return anchors
          .map(a => a.href)
          .filter(href => {
            try {
              const linkUrl = new URL(href);
              const linkDomain = linkUrl.hostname.replace(/^www\./, '');
              return linkDomain === domain || linkDomain.endsWith('.' + domain);
            } catch {
              return false;
            }
          });
      }, baseDomain);

      for (const link of links.slice(0, 10)) {
        if (!visited.has(link) && toVisit.length < 100) {
          toVisit.push(link);
        }
      }

    } catch (error) {
      console.error(`Failed to crawl ${url}:`, error.message);
    }
  }

  await browser.close();
  return forms;
}

async function main() {
  console.log('Starting crawler...');
  
  await ensureDirectories();
  
  console.log('Fetching domains...');
  const allDomains = await fetchDomains();
  console.log(`Found ${allDomains.length} domains`);
  
  const stats = await loadScannedDomains();
  const scannedSet = new Set(stats.scanned || []);
  
  const unscannedDomains = allDomains.filter(d => !scannedSet.has(d));
  
  if (unscannedDomains.length === 0) {
    console.log('All domains have been scanned. Resetting...');
    stats.scanned = [];
    stats.lastUpdate = new Date().toISOString();
    await saveScannedDomains(stats);
    return;
  }

  let formsFound = false;
  let domainIndex = 0;
  const maxAttempts = Math.min(unscannedDomains.length, MAX_DOMAIN_ATTEMPTS);
  
  while (!formsFound && domainIndex < maxAttempts) {
    const domainToCrawl = unscannedDomains[domainIndex];
    console.log(`Crawling domain: ${domainToCrawl}`);
    
    try {
      const forms = await crawlDomain(domainToCrawl);
      console.log(`Found ${forms.length} forms on ${domainToCrawl}`);
      
      if (forms.length > 0) {
        await saveResults(forms);
        console.log('Results saved');
        formsFound = true;
      } else {
        console.log(`No forms found on ${domainToCrawl}, will try next domain`);
      }
      
      stats.scanned.push(domainToCrawl);
      stats.lastUpdate = new Date().toISOString();
      await saveScannedDomains(stats);
      console.log('Stats updated');
      
    } catch (error) {
      console.error(`Error crawling ${domainToCrawl}:`, error);
      console.log('Domain unreachable or crawl failed, trying next domain');
      stats.scanned.push(domainToCrawl);
      stats.lastUpdate = new Date().toISOString();
      await saveScannedDomains(stats);
    }
    
    domainIndex++;
  }
  
  if (formsFound) {
    console.log('Crawler completed successfully - forms found!');
  } else {
    console.log(`Crawler completed - attempted ${domainIndex} domains, no forms found`);
  }
}

main().catch(console.error);
