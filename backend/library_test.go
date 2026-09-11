package main

import (
	"strings"
	"testing"
)

// A faithful slice of ollama.com/search's SSR HTML (two result <li>s) so the
// parser is tested against the real structure without a network dependency.
const searchHTMLSnippet = `<ul role="list" class="grid grid-cols-1">
<li  class="flex items-baseline border-b border-neutral-200 py-6">
  <a href="/library/llama3.2" class="group w-full">
    <div class="flex flex-col mb-1" title="llama3.2">
      <h2 class="truncate text-xl font-medium underline-offset-2 group-hover:underline md:text-2xl">
        <span >llama3.2</span>
      </h2>
      <p class="max-w-lg break-words text-neutral-800 text-md">Meta&#39;s Llama 3.2 goes small with 1B and 3B models. </p>
    </div>
    <div class="flex flex-col">
      <div class="flex flex-wrap space-x-2">
        <span  class="inline-flex my-1 items-center rounded-md bg-indigo-50 px-2 py-[2px] text-xs font-medium text-indigo-600 sm:text-[13px]">tools</span>
        <span  class="inline-flex my-1 items-center rounded-md bg-[#ddf4ff] px-2 py-[2px] text-xs font-medium text-blue-600 sm:text-[13px]">1b</span>
        <span  class="inline-flex my-1 items-center rounded-md bg-[#ddf4ff] px-2 py-[2px] text-xs font-medium text-blue-600 sm:text-[13px]">3b</span>
      </div>
      <p class="my-1 flex space-x-5 text-[13px] font-medium text-neutral-500">
        <span class="flex items-center">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="mr-1.5 h-[14px] w-[14px] sm:h-4 sm:w-4"><path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"></path></svg>
          <span >83M</span>
          <span class="hidden sm:flex">&nbsp;Pulls</span>
        </span>
        <span class="flex items-center">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="mr-1.5 h-[14px] w-[14px] sm:h-4 sm:w-4"><path stroke-linecap="round" stroke-linejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" /></svg>
          <span >63</span>
          <span class="hidden sm:flex">&nbsp;Tags</span>
        </span>
        <span class="flex items-center" title="Sep 25, 2024 9:09 PM UTC">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="mr-1.5 h-[14px] w-[14px] sm:h-4 sm:w-4"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"></path></svg>
          <span class="hidden sm:flex">Updated&nbsp;</span>
          <span >1 year ago</span>
        </span>
      </p>
    </div>
  </a>
</li>
<li  class="flex items-baseline border-b border-neutral-200 py-6">
  <a href="/library/llama3.2-vision" class="group w-full">
    <div class="flex flex-col mb-1" title="llama3.2-vision">
      <h2 class="truncate text-xl font-medium underline-offset-2 group-hover:underline md:text-2xl"><span >llama3.2-vision</span></h2>
      <p class="max-w-lg break-words text-neutral-800 text-md">Llama 3.2 Vision is a collection of instruction-tuned image reasoning generative models in 11B and 90B sizes.</p>
    </div>
    <div class="flex flex-col">
      <div class="flex flex-wrap space-x-2">
        <span  class="inline-flex my-1 items-center rounded-md bg-indigo-50 px-2 py-[2px] text-xs font-medium text-indigo-600 sm:text-[13px]">vision</span>
        <span  class="inline-flex my-1 items-center rounded-md bg-[#ddf4ff] px-2 py-[2px] text-xs font-medium text-blue-600 sm:text-[13px]">11b</span>
        <span  class="inline-flex my-1 items-center rounded-md bg-[#ddf4ff] px-2 py-[2px] text-xs font-medium text-blue-600 sm:text-[13px]">90b</span>
      </div>
      <p class="my-1 flex space-x-5 text-[13px] font-medium text-neutral-500">
        <span class="flex items-center"><svg></svg><span >5.2M</span><span class="hidden sm:flex">&nbsp;Pulls</span></span>
        <span class="flex items-center"><svg></svg><span >9</span><span class="hidden sm:flex">&nbsp;Tags</span></span>
        <span class="flex items-center" title="May 22, 2025 7:15 PM UTC"><svg></svg><span class="hidden sm:flex">Updated&nbsp;</span><span >1 year ago</span></span>
      </p>
    </div>
  </a>
</li>
</ul>`

func TestParseOllamaSearchHTML(t *testing.T) {
	got := parseOllamaSearchHTML([]byte(searchHTMLSnippet))
	if len(got) != 2 {
		t.Fatalf("got %d models, want 2", len(got))
	}
	m := got[0]
	if m.Name != "llama3.2" {
		t.Errorf("name = %q, want llama3.2", m.Name)
	}
	if !strings.Contains(m.Description, "Meta's Llama 3.2") {
		t.Errorf("description = %q, want it to contain the unescaped apostrophe", m.Description)
	}
	if len(m.Capabilities) != 1 || m.Capabilities[0] != "tools" {
		t.Errorf("capabilities = %+v, want [tools]", m.Capabilities)
	}
	if len(m.Sizes) != 2 || m.Sizes[0] != "1b" || m.Sizes[1] != "3b" {
		t.Errorf("sizes = %+v, want [1b 3b]", m.Sizes)
	}
	if m.Pulls != "83M" {
		t.Errorf("pulls = %q, want 83M", m.Pulls)
	}
	if m.Tags != "63" {
		t.Errorf("tags = %q, want 63", m.Tags)
	}
	if !strings.Contains(m.Updated, "1 year") {
		t.Errorf("updated = %q, want it to contain '1 year'", m.Updated)
	}
	if m.URL != "https://ollama.com/library/llama3.2" {
		t.Errorf("url = %q, want the library URL", m.URL)
	}

	v := got[1]
	if v.Name != "llama3.2-vision" {
		t.Errorf("name = %q, want llama3.2-vision", v.Name)
	}
	if len(v.Capabilities) != 1 || v.Capabilities[0] != "vision" {
		t.Errorf("capabilities = %+v, want [vision]", v.Capabilities)
	}
	if len(v.Sizes) != 2 || v.Sizes[0] != "11b" || v.Sizes[1] != "90b" {
		t.Errorf("sizes = %+v, want [11b 90b]", v.Sizes)
	}
	if v.Pulls != "5.2M" {
		t.Errorf("pulls = %q, want 5.2M", v.Pulls)
	}
	if v.Tags != "9" {
		t.Errorf("tags = %q, want 9", v.Tags)
	}
}

// A changed/empty structure yields zero results, not an error — the caller
// falls back to the curated catalog.
func TestParseOllamaSearchHTML_Empty(t *testing.T) {
	if got := parseOllamaSearchHTML([]byte("<html><body>nothing here</body></html>")); len(got) != 0 {
		t.Errorf("got %d models, want 0 for non-matching HTML", len(got))
	}
}
