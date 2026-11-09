package main

import (
	"fmt"
	"net/http"
	"strings"
)

func main() {
	http.HandleFunc("/echo/", func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimPrefix(r.URL.Path, "/echo/")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"id":%q,"message":"ok"}`, id)
	})
	http.ListenAndServe("127.0.0.1:18080", nil)
}
