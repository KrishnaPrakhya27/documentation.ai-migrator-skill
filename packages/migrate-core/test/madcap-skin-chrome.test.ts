/**
 * A published Flare page renders skin furniture *inside* the topic body: the toolbar that moves
 * between topics, the menu skins, the search box, and whatever the page template injects beside
 * them. None of it is authored content, and exact mode has no way to drop it later — it permits a
 * rule to remove only script and style — so the article the migrator reads must not contain it.
 *
 * The markup here is as learn.sessionm.com serves it.
 */
import { describe, it, expect } from 'vitest';
import { htmlToIr } from '../src/ir/from-html.js';
import { getProfile, htmlAdapterOptions } from '../src/scrape/profiles.js';

const page = (body: string): string => `<html data-mc-path-to-help-system=""><body><div data-mc-content-body="True">${body}</div></body></html>`;
const ir = (body: string) => htmlToIr(page(body), htmlAdapterOptions(getProfile('madcap'), { platform: 'madcap', file: 'topic.htm' }));
const textOf = (doc: { children: unknown[] }): string => JSON.stringify(doc.children);

const TOPIC = '<h2>Set up platform time zone</h2><p>The platform time zone applies to every campaign.</p>';

describe('Flare skin furniture inside the topic body', () => {
  it('reads the topic, not the content wrapper that also holds the copyright line', () => {
    // The wrapper is an ancestor of the topic, so document order matched it first and the footer
    // came along. The topic selector is tried first now, and the footer is skin either way.
    const html = `<html data-mc-path-to-help-system=""><body><div data-mc-content-body="True"><div class="newtopic-wrap"><div role="main" id="mc-main-content">${TOPIC}</div></div><div class="light-footer"><p class="copyright">©2025 Acme | All rights reserved</p></div></div></body></html>`;
    const doc = htmlToIr(html, htmlAdapterOptions(getProfile('madcap'), { platform: 'madcap', file: 'topic.htm' }));
    expect(textOf(doc)).not.toContain('All rights reserved');
    expect(textOf(doc)).toContain('The platform time zone applies to every campaign.');
  });

  it('drops the topic toolbar Flare itself marks nocontent, and keeps the topic', () => {
    const doc = ir(`${TOPIC}<div class="buttons popup-container clearfix topicToolbarProxy _Skins_Toolbar mc-component nocontent" style="mc-topic-toolbar-items: PreviousTopic NextTopic;"><div class="button-group-container-left"><button class="button needs-pie next-topic-button" title="View next article" disabled="true"><div><div role="img" class="button-icon-wrapper" aria-label="View next article"></div></div></button></div></div>`);
    expect(textOf(doc)).not.toContain('View next article');
    expect(textOf(doc)).toContain('The platform time zone applies to every campaign.');
  });

  it('drops the menu skins, which carry navigation rather than text', () => {
    expect(textOf(ir(`${TOPIC}<div class="_Skins_SideMenuSkin mc-component menu nocontent"><a href="other.htm">Other topic</a></div>`))).not.toContain('Other topic');
  });

  it('drops the cookie-consent control the template injects', () => {
    expect(textOf(ir(`${TOPIC}<button id="ot-sdk-btn" class="csh-hide ot-sdk-show-settings c-button c-button--primary c-button--h-xs">Manage Cookies</button>`))).not.toContain('Manage Cookies');
  });

  it('drops the whole search box, not only the bar inside it', () => {
    const doc = ir(`<div class="nav-search-wrapper"><div class="nav-search row"><form class="search" action="#"><div class="search-bar search-bar-container needs-pie"><input class="search-field" type="search" aria-label="Search Field" placeholder="Search" /></div></form></div></div>${TOPIC}`);
    expect(textOf(doc)).not.toContain('search');
    expect(textOf(doc)).toContain('Set up platform time zone');
  });

  it('drops the landing-page hero\'s search box but keeps the heading beside it', () => {
    const doc = ir('<div class="new-topic-hero"><div class="new-topic-hero-wrap"><h1>SessionM Help Center</h1><form class="search" action="#"><div class="search-bar search-bar-container"><input class="search-field" type="search" /></div></form></div></div><p>Browse the procedures below.</p>');
    expect(textOf(doc)).not.toContain('search-field');
    expect(textOf(doc)).toContain('SessionM Help Center');
    expect(textOf(doc)).toContain('Browse the procedures below.');
  });

  it('drops a code snippet\'s copy control but keeps its caption and code', () => {
    const doc = ir('<div class="codeSnippet"><a class="codeSnippetCopyButton" role="button" href="javascript:void(0);">Copy</a><div class="codeSnippetCaption">Example of a simple custom event</div><pre><code>{"event": "purchase"}</code></pre></div>');
    expect(textOf(doc)).not.toContain('Copy');
    expect(textOf(doc)).toContain('Example of a simple custom event');
    expect(textOf(doc)).toContain('purchase');
  });

  it('keeps a topic that writes the word "nocontent" itself: only Flare\'s own components go', () => {
    expect(textOf(ir(`<h2>Styles</h2><p class="nocontent">Use the nocontent class to exclude a block from search.</p>`))).toContain('Use the nocontent class to exclude a block from search.');
  });
});
