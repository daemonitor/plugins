export default class Renderable {
    render() {
        return h(
            "div",
            Array.from({length: 20}).map(() => {
                return h("p", "hi")
            })
        )
    }
}
