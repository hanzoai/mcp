// ... (existing imports)
import (
    "encoding/json"
    // ...
)

// Add to the existing HanzoMCP struct or tool registration logic:

func (s *Server) registerACITools() {
    aci := NewACIController("./vfs") // Assuming vfs as root

    s.RegisterTool("aci_view", "View file with line numbers and windowing", func(args json.RawMessage) (interface{}, error) {
        var opts ACIViewOptions
        if err := json.Unmarshal(args, &opts); err != nil {
            return nil, err
        }
        return aci.ViewFile(opts), nil
    })

    s.RegisterTool("aci_edit", "Deterministic search-and-replace editing", func(args json.RawMessage) (interface{}, error) {
        var opts ACIEditOptions
        if err := json.Unmarshal(args, &opts); err != nil {
            return nil, err
        }
        return aci.EditFile(opts), nil
    })
}
