// ==UserScript==
// @name         Genmetrika.eu Gallery
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Modal gallery for genmetrika.eu: view all thumbnails, large images, zoom, rotate, and navigate with keyboard or mouse. Use arrows, +/-, or mouse wheel to navigate and zoom.
// @author       Alfonsas Cirtautas
// @updateURL    https://raw.githubusercontent.com/acirtautas/genmetrika-gallery/main/genmetrika-gallery.user.js
// @downloadURL  https://raw.githubusercontent.com/acirtautas/genmetrika-gallery/main/genmetrika-gallery.user.js
// @match        *://*.genmetrika.eu/*/content/*.html
// @match        *://*.genmetrika.rf.gd/*/content/*.html
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @connect      genmetrika.eu
// @connect      genmetrika.rf.gd
// ==/UserScript==
(function() {
    'use strict';

    // Remove colored borders from thumbnails using GM_addStyle
    if (typeof GM_addStyle === 'function') {
        GM_addStyle(`
            .thumbnail img, .thumbnail a img, img[style*="border"], img[style*="border-color"] {
                border: none !important;
                box-shadow: none !important;
            }
            #genmetrika-gallery-triangle {
                position: fixed;
                top: 0;
                right: 0;
                width: 0;
                height: 0;
                border-top: 60px solid #0af;
                border-left: 60px solid transparent;
                z-index: 10002;
                cursor: pointer;
                transition: border-top-color 0.2s;
            }
            #genmetrika-gallery-triangle:hover {
                border-top-color: #0977c2;
            }
        `);
    }

    // Utility: Promisified GM_xmlhttpRequest for page fetching
    function fetchPage(url) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest !== 'function') {
                reject(new Error('GM_xmlhttpRequest is not available.'));
                return;
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                onload: function(response) {
                    if (response.status === 200) resolve(response.responseText);
                    else reject(new Error('Failed to load ' + url));
                }
                // onerror handled below
            });
        });
    }

    // Parse thumbnails and large image page links from index page HTML
    function parseThumbnails(html, baseUrl) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const thumbNodes = doc.querySelectorAll('.thumbnail a[href$="_large.html"]');
        const thumbs = [];
        thumbNodes.forEach(a => {
            const img = a.querySelector('img');
            if (img) {
                thumbs.push({
                    thumb: new URL(img.getAttribute('src'), baseUrl).href,
                    largePage: new URL(a.getAttribute('href'), baseUrl).href
                });
            }
        });
        return thumbs;
    }

    // Parse large image src from a single image page
    function parseLargeImage(html, baseUrl) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const img = doc.querySelector('#detailImage img');
        if (img) return new URL(img.getAttribute('src'), baseUrl).href;
        return null;
    }

    // Parse pagination links from index page
    function parsePaginationLinks(html, baseUrl) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const links = Array.from(doc.querySelectorAll('.pagination a[href]'));
        const urls = links.map(a => new URL(a.getAttribute('href'), baseUrl).href);
        // Always include current page
        urls.unshift(baseUrl);
        // Remove duplicates
        return Array.from(new Set(urls));
    }

    // Modal user interface
    function createModal() {
        const overlay = document.createElement('div');
        overlay.style = `position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;background:rgba(0,0,0,0.97);display:flex;align-items:stretch;justify-content:center;`;
        overlay.tabIndex = 0;
        overlay.addEventListener('keydown', e => {
            if (e.key === 'Escape') document.body.removeChild(overlay);
        });
        overlay.onclick = e => { if (e.target === overlay) document.body.removeChild(overlay); };
        return overlay;
    }

    function showGalleryModal(gallery, startIdx = 0) {
        let current = startIdx;
        let rotate = 0;
        const overlay = createModal();
        // Frame: flexible columns layout
        const frame = document.createElement('div');
        frame.style = `background:#222;padding:0;border-radius:0;display:flex;flex-direction:column;max-width:100vw;max-height:100vh;width:100vw;height:100vh;box-shadow:0 0 32px #000;`;
        // Header, styled like controls
        const header = document.createElement('div');
        header.textContent = document.title;
        header.style = 'width:100%;text-align:center;font-size:1.25em;font-weight:600;color:#fff;background:rgba(66,66,66,0.92);padding:14px 0 10px 0;letter-spacing:0.02em;border-radius:18px 18px 0 0;box-shadow:0 2px 8px #0002;margin-bottom:0;z-index:2;';
        frame.appendChild(header);
        // Main area (sidebar + image)
        const mainArea = document.createElement('div');
        mainArea.style = 'display:flex;flex:1 1 0%;min-height:0;min-width:0;overflow:hidden;';
        // Sidebar
        const sidebar = document.createElement('div');
        sidebar.style = `display:flex;flex-direction:column;gap:8px;overflow-y:auto;height:100%;width:90px;background:#181818;padding:16px 8px;`;
        // Main image
        const mainImgBox = document.createElement('div');
        mainImgBox.style = `display:flex;align-items:center;justify-content:center;flex:1 1 0%;height:100%;width:100%;position:relative;overflow:hidden;min-width:0;min-height:0;`;
        const mainImg = document.createElement('img');
        mainImg.alt = 'Gallery image';
        mainImg.style = `display:block;max-width:100%;max-height:100%;margin:0 auto;border-radius:8px;box-shadow:0 0 16px #111;transition:all 0.2s;object-fit:contain;`;
        mainImgBox.appendChild(mainImg);
        // Controls bar with SVG icons (now at the bottom of the frame)
        const controls = document.createElement('div');
        controls.style = 'width:100%;position:relative;bottom:0;left:0;z-index:2;background:rgba(66,66,66,0.92);padding:10px 16px;border-radius:0 0 18px 18px;box-shadow:0 -2px 12px #888;display:flex;gap:14px;align-items:center;justify-content:center;font-size:20px;';
        controls.innerHTML = `
            <button id="prevImg" title="Previous image" class="svg-btn">${svgIcon('prev')}</button>
            <span id="pageInfo" style="font-size:16px;padding:0 8px;min-width:60px;text-align:center;color:#fff;"></span>
            <button id="nextImg" title="Next image" class="svg-btn">${svgIcon('next')}</button>
            <span class="gallery-spacer">|</span>
            <button id="zoomIn" title="Zoom in" class="svg-btn">${svgIcon('zoomIn')}</button>
            <button id="zoomOut" title="Zoom out" class="svg-btn">${svgIcon('zoomOut')}</button>
            <button id="reset" title="Reset zoom/rotation" class="svg-btn">${svgIcon('reset')}</button>
            <span class="gallery-spacer">|</span>
            <button id="rotateLeft" title="Rotate left" class="svg-btn">${svgIcon('rotateLeft')}</button>
            <button id="rotateRight" title="Rotate right" class="svg-btn">${svgIcon('rotateRight')}</button>
            <span class="gallery-spacer">|</span>
            <button id="copyLink" title="Copy image link" class="svg-btn">${svgIcon('copy')}</button>
            <button id="closeModal" title="Close gallery" class="svg-btn">${svgIcon('close')}</button>
        `;
        // SVG icons helper function
        function svgIcon(name) {
            switch(name) {
                case 'prev': return '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M14 7.5l-6 4.5 6 4.5v-9zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" fill="currentColor"/></svg>';
                case 'next': return '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M10 16.5l6-4.5-6-4.5v9zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" fill="currentColor"/></svg>';
                case 'zoomIn': return '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M13 7h-2v4H7v2h4v4h2v-4h4v-2h-4V7zm-1-5C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" fill="currentColor"/></svg>';
                case 'zoomOut': return '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M7 11v2h10v-2H7zm5-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z" fill="currentColor"/></svg>';
                case 'reset': return '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M6,15H9v3h2V13H6Zm9-6V6H13v5h5V9Z" fill="currentColor"/><path d="M12,2A10,10,0,1,0,22,12,10,10,0,0,0,12,2Zm0,18a8,8,0,1,1,8-8,8,8,0,0,1-8,8Z" fill="currentColor"/></svg>';
                case 'rotateLeft': return '<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"/><path d="M8.5 12a3.5 3.5 0 1 1 3.5 3.5" stroke="currentColor" stroke-width="2" fill="none"/><polygon points="8 8 8 13 13 13" fill="currentColor"/></svg>';
                case 'rotateRight': return '<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"/><path d="M15.5 12a3.5 3.5 0 1 0-3.5 3.5" stroke="currentColor" stroke-width="2" fill="none"/><polygon points="16 8 16 13 11 13" fill="currentColor"/></svg>';
                case 'copy': return '<svg width="24" height="24" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><rect x="3" y="3" width="10" height="10" rx="2" stroke="currentColor" stroke-width="2" fill="none"/></svg>';
                case 'close': return '<svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"/><line x1="8" y1="8" x2="16" y2="16" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><line x1="16" y1="8" x2="8" y2="16" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>';
                default: return '';
            }
        }
        // Add SVG button style
        if (typeof GM_addStyle === 'function') {
            GM_addStyle(`
                .svg-btn {
                    background: none !important;
                    border: none !important;
                    border-radius: 0 !important;
                    box-shadow: none !important;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 0 4px;
                    transition: transform 0.15s, filter 0.15s;
                }
                .svg-btn svg {
                    display: block;
                    color: #fff !important;
                    stroke: #fff !important;
                }
                .svg-btn:hover svg {
                    filter: brightness(1.5);
                    transform: scale(1.18);
                }
                .svg-btn:active svg {
                    filter: brightness(0.7);
                    transform: scale(0.95);
                }
                .gallery-spacer {
                    color: rgba(255,255,255,0.75) !important;
                }
                .active-thumb img {
                    border: 2px solid #fff !important;
                    background: rgba(255,255,255,0.10) !important;
                }
            `);
        }
        controls.onclick = e => e.stopPropagation();
        // Assemble main area
        mainArea.appendChild(sidebar);
        mainArea.appendChild(mainImgBox);
        frame.appendChild(mainArea);
        frame.appendChild(controls); // controls at the bottom
        overlay.appendChild(frame);
        document.body.appendChild(overlay);
        overlay.focus();

        // --- GALLERY FUNCTIONALITY ---
        let scale = 1;
        let panX = 0, panY = 0;
        let isPanning = false, startX = 0, startY = 0, startPanX = 0, startPanY = 0;
        const pageInfo = controls.querySelector('#pageInfo');

        // Sidebar thumbs
        sidebar.innerHTML = '';
        gallery.forEach((img, idx) => {
            const thumbBox = document.createElement('div');
            thumbBox.style = 'display:flex;flex-direction:column;align-items:center;gap:2px;';
            const thumb = document.createElement('img');
            thumb.src = img.thumb;
            thumb.alt = `Thumbnail ${idx + 1}`;
            thumb.style = `width:64px;height:64px;object-fit:cover;cursor:pointer;border-radius:6px;border:2px solid transparent;transition:background 0.2s;`;
            thumb.onclick = (event) => { event.stopPropagation(); setMain(idx); };
            // Page number label
            const pageLabel = document.createElement('span');
            pageLabel.textContent = (idx + 1).toString();
            pageLabel.style = 'font-size:12px;color:#aaa;margin-top:2px;user-select:none;';
            thumbBox.appendChild(thumb);
            thumbBox.appendChild(pageLabel);
            sidebar.appendChild(thumbBox);
        });

        // Set main image
        function setMain(idx) {
            current = idx;
            scale = 1; panX = 0; panY = 0;
            // Apply gray filter to indicate loading
            mainImg.style.filter = 'grayscale(1) brightness(0.7)';
            mainImg.onload = () => {
                mainImg.style.filter = '';
                updateTransform();
            };
            mainImg.onerror = () => {
                mainImg.style.filter = 'grayscale(1) brightness(0.7)';
            };
            mainImg.src = gallery[idx].largeImg;
            updateTransform();
            Array.from(sidebar.children).forEach((el, i) => {
                if (i === idx) {
                    el.classList.add('active-thumb');
                } else {
                    el.classList.remove('active-thumb');
                }
            });
            // Scroll active thumb into center of sidebar
            if (sidebar.children[idx]) {
                sidebar.children[idx].scrollIntoView({block: "center", behavior: "smooth"});
            }
            if (pageInfo) pageInfo.textContent = `${current + 1} / ${gallery.length}`;
            if (history.replaceState) {
                history.replaceState(null, '', gallery[idx].largePage);
            }
        }
        setMain(current);

        // Controls event handlers
        controls.querySelector('#zoomIn').onclick = () => { scale *= 1.2; if (scale > 10) scale = 10; updateTransform(); };
        controls.querySelector('#zoomOut').onclick = () => { scale /= 1.2; if (scale < 1) scale = 1; if (scale === 1) { panX = 0; panY = 0; } updateTransform(); };
        controls.querySelector('#rotateLeft').onclick = () => { rotate -= 90; updateTransform(); };
        controls.querySelector('#rotateRight').onclick = () => { rotate += 90; updateTransform(); };
        controls.querySelector('#reset').onclick = () => { scale = 1; rotate = 0; panX = 0; panY = 0; updateTransform(); };
        controls.querySelector('#prevImg').onclick = () => { if (current > 0) { setMain(current - 1); } };
        controls.querySelector('#nextImg').onclick = () => { if (current < gallery.length - 1) { setMain(current + 1); } };
        controls.querySelector('#copyLink').onclick = () => {
            if (typeof GM_setClipboard === 'function') {
                GM_setClipboard(gallery[current].largePage, 'text');
            } else if (navigator.clipboard) {
                navigator.clipboard.writeText(gallery[current].largePage);
            } else {
                alert('Clipboard API is not available.');
            }
        };
        controls.querySelector('#closeModal').onclick = () => {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        };
        // Keyboard navigation
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight' && current < gallery.length - 1) setMain(current + 1);
            if (e.key === 'ArrowLeft' && current > 0) setMain(current - 1);
            if (e.key === 'Escape') {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }
            // Zoom in with + or =
            if ((e.key === '+' || e.key === '=' || e.key === 'Add') && !e.ctrlKey && !e.metaKey) {
                scale *= 1.2; if (scale > 10) scale = 10; updateTransform();
                e.preventDefault();
            }
            // Zoom out with - or _
            if ((e.key === '-' || e.key === '_' || e.key === 'Subtract') && !e.ctrlKey && !e.metaKey) {
                scale /= 1.2; if (scale < 1) scale = 1; if (scale === 1) { panX = 0; panY = 0; } updateTransform();
                e.preventDefault();
            }
        });
        // Pan and zoom
        mainImgBox.addEventListener('mousedown', (e) => {
            if (scale <= 1) return;
            isPanning = true;
            startX = e.clientX;
            startY = e.clientY;
            startPanX = panX;
            startPanY = panY;
            mainImgBox.style.cursor = 'grabbing';
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!isPanning) return;
            panX = startPanX + (e.clientX - startX);
            panY = startPanY + (e.clientY - startY);
            updateTransform();
        });
        window.addEventListener('mouseup', (_) => {
            if (isPanning) {
                isPanning = false;
                mainImgBox.style.cursor = '';
            }
        });
        mainImgBox.addEventListener('mouseleave', (_) => {
            if (isPanning) {
                isPanning = false;
                mainImgBox.style.cursor = '';
            }
        });
        mainImgBox.addEventListener('wheel', e => {
            e.preventDefault();
            const prevScale = scale;
            if (e.deltaY < 0) scale *= 1.15;
            else scale /= 1.15;
            scale = Math.max(1, Math.min(scale, 10));
            if (scale > 1) {
                const rect = mainImg.getBoundingClientRect();
                const mx = e.clientX - rect.left;
                const my = e.clientY - rect.top;
                const dx = mx - rect.width / 2;
                const dy = my - rect.height / 2;
                panX -= dx * (scale / prevScale - 1);
                panY -= dy * (scale / prevScale - 1);
            } else {
                panX = 0; panY = 0;
            }
            updateTransform();
        }, { passive: false });
        function updateTransform() {
            mainImg.style.transform = `translate(${panX}px,${panY}px) scale(${scale}) rotate(${rotate}deg)`;
            mainImg.style.transformOrigin = 'center center';
            fitImage();
        }
        function fitImage() {
            const sidebarWidth = sidebar.offsetWidth || 90;
            const containerW = mainImgBox.offsetWidth || (window.innerWidth - sidebarWidth);
            const containerH = mainImgBox.offsetHeight || window.innerHeight;
            const deg = ((rotate % 360) + 360) % 360;
            mainImg.style.width = '';
            mainImg.style.height = '';
            if (deg === 90 || deg === 270) {
                mainImg.style.maxWidth = containerH + 'px';
                mainImg.style.maxHeight = containerW + 'px';
            } else {
                mainImg.style.maxWidth = containerW + 'px';
                mainImg.style.maxHeight = containerH + 'px';
            }
        }
        window.addEventListener('resize', updateTransform);
    }

    // --- Loading screen/modal ---
    function showLoadingScreen(message = 'Loading gallery...') {
        let loading = document.getElementById('genmetrika-gallery-loading');
        if (!loading) {
            loading = document.createElement('div');
            loading.id = 'genmetrika-gallery-loading';
            loading.style = `position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:100000;background:rgba(0,0,0,0.92);display:flex;align-items:center;justify-content:center;`;
            loading.innerHTML = `
                <div style="display:flex;flex-direction:column;align-items:center;gap:24px;">
                    <div class="gallery-spinner" style="width:64px;height:64px;border:8px solid #eee;border-top:8px solid #0af;border-radius:50%;animation:gallery-spin 1s linear infinite;"></div>
                    <div style="color:#fff;font-size:1.3em;font-weight:500;text-align:center;">${message}</div>
                </div>
            `;
            if (typeof GM_addStyle === 'function') {
                GM_addStyle(`@keyframes gallery-spin { 0%{transform:rotate(0deg);} 100%{transform:rotate(360deg);} }`);
            }
            document.body.appendChild(loading);
        } else {
            loading.querySelector('div:last-child').textContent = message;
            loading.style.display = 'flex';
        }
    }
    function hideLoadingScreen() {
        const loading = document.getElementById('genmetrika-gallery-loading');
        if (loading) loading.style.display = 'none';
    }

    // Main logic: fetch all page thumbnails and large images
    async function buildGallery(startLargeImgUrl) {
        showLoadingScreen();
        let baseUrl, firstPageHtml, indexUrl = null, startIdx = 0;
        // Determine if we are on a large image page
        const indexLink = document.querySelector('.index a, li.index a');
        if (indexLink) {
            indexUrl = new URL(indexLink.getAttribute('href'), window.location.href).href;
        }
        if (document.querySelector('#detailImage img') && indexUrl) {
            // On a large image page: fetch index
            baseUrl = indexUrl;
            firstPageHtml = await fetchPage(indexUrl);
        } else {
            // On an index page
            baseUrl = window.location.href;
            firstPageHtml = document.documentElement.outerHTML;
        }
        // Find all page links
        const pageUrls = parsePaginationLinks(firstPageHtml, baseUrl);
        // Fetch all pages
        const htmls = await Promise.all(pageUrls.map(url => url === baseUrl ? Promise.resolve(firstPageHtml) : fetchPage(url)));
        // Parse all thumbnails
        let allThumbs = [];
        for (let i = 0; i < htmls.length; ++i) {
            const thumbs = parseThumbnails(htmls[i], pageUrls[i]);
            allThumbs = allThumbs.concat(thumbs);
        }
        // Fetch all large image URLs
        const largeHtmls = await Promise.all(allThumbs.map(t => fetchPage(t.largePage)));
        for (let i = 0; i < allThumbs.length; ++i) {
            allThumbs[i].largeImg = parseLargeImage(largeHtmls[i], allThumbs[i].largePage);
        }
        // If on a large image page, set startIdx to current image
        if (startLargeImgUrl) {
            const idx = allThumbs.findIndex(t => t.largeImg === startLargeImgUrl);
            if (idx !== -1) startIdx = idx;
        }
        hideLoadingScreen();
        return {allThumbs, startIdx};
    }

    // Add triangle strip for gallery opening
    function addGalleryTriangle() {
        // Remove triangle if it exists and the page is not a gallery page
        const existing = document.getElementById('genmetrika-gallery-triangle');
        // Show triangle if there are at least 2 image links (index) OR a large image is present (detail)
        const thumbLinks = Array.from(document.querySelectorAll('a img')).map(img => img.closest('a')).filter(Boolean);
        const isGalleryPage = (thumbLinks.length >= 2) || document.querySelector('#detailImage img');
        if (!isGalleryPage) {
            if (existing) existing.remove();
            return;
        }
        if (existing) return;
        // Triangle clickable area
        const triangle = document.createElement('div');
        triangle.id = 'genmetrika-gallery-triangle';
        triangle.title = 'Open gallery';
        triangle.setAttribute('aria-label', 'Open gallery');
        triangle.onclick = async (e) => {
            e.stopPropagation();
            triangle.style.pointerEvents = 'none';
            try {
                showLoadingScreen();
                let startLargeImgUrl = null;
                const img = document.querySelector('#detailImage img');
                if (img) startLargeImgUrl = new URL(img.getAttribute('src'), window.location.href).href;
                const {allThumbs, startIdx} = await buildGallery(startLargeImgUrl);
                hideLoadingScreen();
                showGalleryModal(allThumbs, startIdx);
            } catch (e) {
                hideLoadingScreen();
                alert('Failed to load gallery: ' + e.message);
            }
            triangle.style.pointerEvents = '';
        };
        document.body.appendChild(triangle);
    }

    // Register Tampermonkey menu command
    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('Open gallery modal', async () => {
            showLoadingScreen();
            let startLargeImgUrl = null;
            const img = document.querySelector('#detailImage img');
            if (img) startLargeImgUrl = new URL(img.getAttribute('src'), window.location.href).href;
            const {allThumbs, startIdx} = await buildGallery(startLargeImgUrl);
            hideLoadingScreen();
            showGalleryModal(allThumbs, startIdx);
        });
    }

    // Initialization: add triangle on load, popstate, and DOM changes
    window.addEventListener('load', addGalleryTriangle);
    window.addEventListener('popstate', addGalleryTriangle);
    const observer = new MutationObserver(() => addGalleryTriangle());
    observer.observe(document.body, {childList: true, subtree: true});
})();
