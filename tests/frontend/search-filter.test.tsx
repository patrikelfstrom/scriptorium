// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"

import { SearchFilter } from "../../src/features/catalog/components/SearchFilter"

function SearchFilterHarness() {
  const [searchText, setSearchText] = useState("")
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(-1)
  const tagSuggestions = ["react", "react-dom", "react-router"]

  return (
    <SearchFilter
      activeSuggestion={
        activeSuggestionIndex >= 0
          ? tagSuggestions[activeSuggestionIndex]
          : undefined
      }
      activeSuggestionIndex={activeSuggestionIndex}
      inputId="catalog-filter"
      isDarkMode={false}
      searchText={searchText}
      selectedTags={selectedTags}
      setActiveSuggestionIndex={setActiveSuggestionIndex}
      setSearchText={setSearchText}
      setSelectedTags={setSelectedTags}
      tagSuggestions={tagSuggestions}
    />
  )
}

describe("SearchFilter", () => {
  it("closes suggestions when pressing Enter", () => {
    render(<SearchFilterHarness />)

    const input = screen.getByRole("combobox", {
      name: "Filter tooling by text and tag",
    })

    fireEvent.change(input, { target: { value: "rea" } })
    expect(screen.getByRole("listbox")).toBeTruthy()

    fireEvent.keyDown(input, { key: "Enter" })

    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("closes suggestions when clicking outside the suggestion list", () => {
    render(<SearchFilterHarness />)

    const input = screen.getByRole("combobox", {
      name: "Filter tooling by text and tag",
    })

    fireEvent.change(input, { target: { value: "rea" } })
    expect(screen.getByRole("listbox")).toBeTruthy()

    fireEvent.pointerDown(document.body)

    expect(screen.queryByRole("listbox")).toBeNull()
  })

  it("moves forward with Tab and backward with Shift+Tab", () => {
    render(<SearchFilterHarness />)

    const input = screen.getByRole("combobox", {
      name: "Filter tooling by text and tag",
    })

    fireEvent.change(input, { target: { value: "rea" } })

    fireEvent.keyDown(input, { key: "Tab" })
    let options = screen.getAllByRole("option")
    expect(options[0]?.getAttribute("aria-selected")).toBe("true")
    expect(options[1]?.getAttribute("aria-selected")).toBe("false")

    fireEvent.keyDown(input, { key: "Tab" })
    options = screen.getAllByRole("option")
    expect(options[1]?.getAttribute("aria-selected")).toBe("true")

    fireEvent.keyDown(input, { key: "Tab", shiftKey: true })
    options = screen.getAllByRole("option")
    expect(options[0]?.getAttribute("aria-selected")).toBe("true")
  })
})
